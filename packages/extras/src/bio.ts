import { setTimeout as sleep } from 'node:timers/promises';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

/**
 * Read-only lookups in public bioinformatics databases: NCBI E-utilities, UniProt and Ensembl REST.
 * Queries and identifiers are sent to those services. Every result carries its source URL
 * (API key removed) and retrievedAt, because database records change over time.
 */

export interface BioToolOptions {
  /** NCBI E-utilities. apiKey defaults to env.NCBI_API_KEY; NCBI asks clients to send an email. false removes the NCBI tools. */
  ncbi?: { apiKey?: string; email?: string; baseUrl?: string } | false;
  /** UniProt REST. false removes the UniProt tools. */
  uniprot?: { baseUrl?: string } | false;
  /** Ensembl REST. false removes the Ensembl tools. */
  ensembl?: { baseUrl?: string } | false;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Largest text returned per call. Default 20000 characters. */
  maxChars?: number;
}

const ID = /^[A-Za-z0-9_.-]{1,40}$/u;
const NCBI_DATABASES = ['gene', 'protein', 'nuccore', 'pubmed', 'pmc', 'snp', 'taxonomy', 'sra', 'biosample', 'bioproject', 'assembly', 'clinvar', 'gds', 'structure'] as const;

/** Space requests to one service at least `ms` apart. */
function pacer(ms: number) {
  let next = 0;
  return async (signal?: AbortSignal) => {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + ms;
    if (wait) await sleep(wait, undefined, { signal });
  };
}

function serviceMessage(text: string): string {
  try {
    const data = JSON.parse(text) as { error?: unknown; message?: unknown; messages?: unknown };
    const message = data.error ?? data.messages ?? data.message;
    if (message) return (typeof message === 'string' ? message : JSON.stringify(message)).slice(0, 300);
  } catch { /* not JSON */ }
  return text.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 300);
}

function sourceOf(url: URL): string {
  const copy = new URL(url);
  copy.searchParams.delete('api_key');
  return copy.href;
}

export function bioTools(options: BioToolOptions = {}): ToolSet {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxChars = options.maxChars ?? 20_000;
  const tools: ToolSet = {};

  async function get(service: string, url: URL, accept: string, signal?: AbortSignal, pace?: (signal?: AbortSignal) => Promise<void>): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      await pace?.(signal);
      const response = await fetch(url, {
        headers: { accept, 'user-agent': 'lab-agent-extras/0.1 (bioTools)' },
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
      });
      // Rate limited: back off and try again, twice at most.
      if (response.status === 429 && attempt < 2) {
        await response.body?.cancel();
        await sleep(1000 * (attempt + 1), undefined, { signal });
        continue;
      }
      const text = await response.text();
      if (!response.ok) throw new Error(`${service} returned ${response.status}: ${serviceMessage(text)}`);
      return text;
    }
  }

  const clip = (text: string) => ({ text: text.slice(0, maxChars), totalChars: text.length, ...(text.length > maxChars ? { truncated: true, note: `Cut at ${maxChars} characters; request fewer records, or save full records with a registered script.` } : {}) });
  const stamp = (url: URL) => ({ source: sourceOf(url), retrievedAt: new Date().toISOString() });

  if (options.ncbi !== false) {
    const ncbi = options.ncbi ?? {};
    const base = (ncbi.baseUrl ?? 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils').replace(/\/$/u, '');
    const apiKey = () => ncbi.apiKey ?? env.NCBI_API_KEY;
    // NCBI allows 3 requests per second without a key and 10 with one.
    const pace = pacer(apiKey() ? 110 : 350);
    const eutil = (name: string, params: Record<string, string>) => {
      const url = new URL(`${base}/${name}.fcgi`);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      url.searchParams.set('tool', 'lab-agent-extras');
      if (ncbi.email) url.searchParams.set('email', ncbi.email);
      const key = apiKey();
      if (key) url.searchParams.set('api_key', key);
      return url;
    };

    tools.ncbiSearch = tool({
      description: 'Search an NCBI database (gene, protein, nuccore, pubmed, …) with Entrez query syntax, e.g. "BRCA1[gene] AND human[orgn]". Returns the hit count, ids and a short summary of each hit. The query is sent to NCBI.',
      inputSchema: z.object({
        db: z.enum(NCBI_DATABASES),
        term: z.string().min(1).max(500),
        maxResults: z.number().int().min(1).max(50).default(10),
      }),
      async execute({ db, term, maxResults }, { abortSignal }) {
        const search = eutil('esearch', { db, term, retmax: String(maxResults), retmode: 'json' });
        const found = JSON.parse(await get('NCBI', search, 'application/json', abortSignal, pace)) as { esearchresult?: { count?: string; idlist?: string[]; errorlist?: unknown } };
        const ids = found.esearchresult?.idlist ?? [];
        const result = { db, term, count: Number(found.esearchresult?.count ?? 0), ids, ...stamp(search) };
        if (!ids.length) return { ...result, results: [] };
        const summary = eutil('esummary', { db, id: ids.join(','), retmode: 'json' });
        const docs = (JSON.parse(await get('NCBI', summary, 'application/json', abortSignal, pace)) as { result?: Record<string, Record<string, unknown>> & { uids?: string[] } }).result ?? {};
        const results = ids.map(id => {
          const doc = docs[id] ?? {};
          const fields: Record<string, unknown> = { id };
          for (const [key, value] of Object.entries(doc)) {
            if (Object.keys(fields).length >= 25) break;
            if (typeof value === 'string' && value) fields[key] = value.length > 400 ? `${value.slice(0, 400)}…` : value;
            else if (typeof value === 'number') fields[key] = value;
          }
          const organism = doc.organism as { scientificname?: string } | undefined;
          if (organism?.scientificname) fields.organism = organism.scientificname;
          const authors = doc.authors as Array<{ name?: string }> | undefined;
          if (Array.isArray(authors)) fields.authors = authors.slice(0, 5).map(author => author.name).filter(Boolean);
          return fields;
        });
        return { ...result, results };
      },
    });

    tools.ncbiFetch = tool({
      description: 'Fetch full NCBI records by id: FASTA or GenBank for sequences (nuccore, protein), abstracts or MEDLINE for pubmed, or XML. Large records are cut; fetch fewer ids at a time. The ids are sent to NCBI.',
      inputSchema: z.object({
        db: z.enum(NCBI_DATABASES),
        ids: z.array(z.string().regex(ID)).min(1).max(20),
        format: z.enum(['fasta', 'genbank', 'abstract', 'medline', 'xml']).default('fasta'),
      }),
      async execute({ db, ids, format }, { abortSignal }) {
        const params: Record<string, string> = { db, id: ids.join(',') };
        if (format === 'xml') params.retmode = 'xml';
        else Object.assign(params, { retmode: 'text', rettype: format === 'genbank' ? (db === 'protein' ? 'gp' : 'gb') : format });
        const url = eutil('efetch', params);
        return { db, ids, format, ...clip(await get('NCBI', url, format === 'xml' ? 'application/xml' : 'text/plain', abortSignal, pace)), ...stamp(url) };
      },
    });
  }

  if (options.uniprot !== false) {
    const base = (options.uniprot?.baseUrl ?? 'https://rest.uniprot.org').replace(/\/$/u, '');
    const pace = pacer(100);

    tools.uniprotSearch = tool({
      description: 'Search UniProtKB with UniProt query syntax, e.g. "gene:TP53 AND organism_id:9606 AND reviewed:true". Returns accessions, names, genes, organism and length. The query is sent to UniProt (EBI).',
      inputSchema: z.object({
        query: z.string().min(1).max(500),
        maxResults: z.number().int().min(1).max(25).default(10),
      }),
      async execute({ query, maxResults }, { abortSignal }) {
        const url = new URL(`${base}/uniprotkb/search`);
        url.searchParams.set('query', query);
        url.searchParams.set('format', 'json');
        url.searchParams.set('size', String(maxResults));
        url.searchParams.set('fields', 'accession,id,protein_name,gene_names,organism_name,length,reviewed');
        type Entry = { primaryAccession?: string; uniProtkbId?: string; entryType?: string; organism?: { scientificName?: string }; sequence?: { length?: number };
          proteinDescription?: { recommendedName?: { fullName?: { value?: string } }; submissionNames?: Array<{ fullName?: { value?: string } }> }; genes?: Array<{ geneName?: { value?: string } }> };
        const data = JSON.parse(await get('UniProt', url, 'application/json', abortSignal, pace)) as { results?: Entry[] };
        const results = (data.results ?? []).map(entry => ({
          accession: entry.primaryAccession, entryName: entry.uniProtkbId,
          reviewed: /reviewed \(Swiss-Prot\)/iu.test(entry.entryType ?? ''),
          protein: entry.proteinDescription?.recommendedName?.fullName?.value ?? entry.proteinDescription?.submissionNames?.[0]?.fullName?.value,
          genes: (entry.genes ?? []).map(gene => gene.geneName?.value).filter(Boolean),
          organism: entry.organism?.scientificName, length: entry.sequence?.length,
        }));
        return { query, results, ...stamp(url) };
      },
    });

    tools.uniprotEntry = tool({
      description: 'One UniProtKB entry by accession (e.g. P04637): FASTA sequence, the flat text record, or JSON. The accession is sent to UniProt.',
      inputSchema: z.object({
        accession: z.string().regex(ID),
        format: z.enum(['fasta', 'text', 'json']).default('fasta'),
      }),
      async execute({ accession, format }, { abortSignal }) {
        const extension = { fasta: 'fasta', text: 'txt', json: 'json' }[format];
        const url = new URL(`${base}/uniprotkb/${encodeURIComponent(accession)}.${extension}`);
        return { accession, format, ...clip(await get('UniProt', url, format === 'json' ? 'application/json' : 'text/plain', abortSignal, pace)), ...stamp(url) };
      },
    });
  }

  if (options.ensembl !== false) {
    const base = (options.ensembl?.baseUrl ?? 'https://rest.ensembl.org').replace(/\/$/u, '');
    // Ensembl allows 15 requests per second.
    const pace = pacer(70);
    const species = z.string().regex(/^[a-z][a-z0-9_]{1,60}$/u).default('homo_sapiens');

    tools.ensemblLookup = tool({
      description: 'Look up a gene or transcript in Ensembl by symbol (with species) or by stable id (e.g. ENSG00000141510): location, biotype, assembly, description. Sent to Ensembl.',
      inputSchema: z.object({
        symbol: z.string().regex(ID).optional(),
        id: z.string().regex(ID).optional(),
        species,
      }).refine(input => !!input.symbol !== !!input.id, 'Give exactly one of symbol or id.'),
      async execute({ symbol, id, species: name }, { abortSignal }) {
        const url = new URL(symbol ? `${base}/lookup/symbol/${name}/${encodeURIComponent(symbol)}` : `${base}/lookup/id/${encodeURIComponent(id!)}`);
        url.searchParams.set('content-type', 'application/json');
        const data = JSON.parse(await get('Ensembl', url, 'application/json', abortSignal, pace)) as Record<string, unknown>;
        const keep = ['id', 'display_name', 'description', 'object_type', 'biotype', 'species', 'assembly_name', 'seq_region_name', 'start', 'end', 'strand', 'canonical_transcript', 'version', 'Parent'];
        return { ...Object.fromEntries(keep.filter(key => data[key] !== undefined).map(key => [key, data[key]])), ...stamp(url) };
      },
    });

    tools.ensemblSequence = tool({
      description: 'Sequence for an Ensembl stable id as FASTA: genomic (default), cdna, cds or protein. Long genomic sequences are cut. Sent to Ensembl.',
      inputSchema: z.object({
        id: z.string().regex(ID),
        type: z.enum(['genomic', 'cdna', 'cds', 'protein']).default('genomic'),
      }),
      async execute({ id, type }, { abortSignal }) {
        const url = new URL(`${base}/sequence/id/${encodeURIComponent(id)}`);
        url.searchParams.set('type', type);
        url.searchParams.set('content-type', 'text/x-fasta');
        return { id, type, ...clip(await get('Ensembl', url, 'text/x-fasta', abortSignal, pace)), ...stamp(url) };
      },
    });
  }

  if (!Object.keys(tools).length) throw new Error('bioTools: every database is turned off.');
  return tools;
}
