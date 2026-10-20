import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { bioTools } from '../../packages/extras/dist/bio.js';
import { callTool } from '../fixtures/project.mjs';

// lab-agent-extras/bio against a local stand-in for NCBI, UniProt and Ensembl. No real service is contacted.

const call = callTool;

async function services(t) {
  const requests = [];
  let rateLimited = false;
  const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const text = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'text/plain' }); res.end(value); };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, at: Date.now() });
    const q = url.searchParams;
    switch (url.pathname) {
      case '/eutils/esearch.fcgi':
        return json(res, { esearchresult: q.get('term') === 'nothing' ? { count: '0', idlist: [] } : { count: '2', idlist: ['672', '12189'] } });
      case '/eutils/esummary.fcgi':
        return json(res, { result: { uids: ['672', '12189'],
          672: { uid: '672', name: 'BRCA1', description: 'BRCA1 DNA repair associated', chromosome: '17', organism: { scientificname: 'Homo sapiens' }, genomicinfo: [{ chrstart: 1 }], summary: 'x'.repeat(1000) },
          12189: { uid: '12189', name: 'Brca1', description: 'breast cancer 1', organism: { scientificname: 'Mus musculus' } } } });
      case '/eutils/efetch.fcgi':
        return text(res, q.get('id').includes('LONG') ? `>LONG\n${'A'.repeat(50_000)}\n` : `>NM_007294.4 Homo sapiens BRCA1 (${q.get('rettype')})\nATGGATTTATCTG\n`);
      case '/uniprot/uniprotkb/search':
        return json(res, { results: [{ primaryAccession: 'P04637', uniProtkbId: 'P53_HUMAN', entryType: 'UniProtKB reviewed (Swiss-Prot)',
          proteinDescription: { recommendedName: { fullName: { value: 'Cellular tumor antigen p53' } } }, genes: [{ geneName: { value: 'TP53' } }], organism: { scientificName: 'Homo sapiens' }, sequence: { length: 393 } }] });
      case '/uniprot/uniprotkb/P04637.fasta':
        return text(res, '>sp|P04637|P53_HUMAN Cellular tumor antigen p53\nMEEPQSDPSV\n');
      case '/uniprot/uniprotkb/NOPE.fasta':
        return json(res, { messages: ['Resource not found'] }, 404);
      case '/ensembl/lookup/symbol/homo_sapiens/TP53':
        return json(res, { id: 'ENSG00000141510', display_name: 'TP53', biotype: 'protein_coding', seq_region_name: '17', start: 7661779, end: 7687538, strand: -1, assembly_name: 'GRCh38', internal: 'dropped' });
      case '/ensembl/lookup/symbol/homo_sapiens/FAKE':
        return json(res, { error: 'No valid lookup found for symbol FAKE' }, 400);
      case '/ensembl/lookup/id/ENSGRATE':
        if (!rateLimited) { rateLimited = true; return json(res, { error: 'Too many requests' }, 429); }
        return json(res, { id: 'ENSGRATE', biotype: 'lncRNA' });
      case '/ensembl/sequence/id/ENSG00000141510':
        return text(res, `>ENSG00000141510 ${q.get('type')}\nGATTACA\n`);
      default:
        return text(res, 'missing', 404);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    requests,
    options: { ncbi: { baseUrl: `${base}/eutils` }, uniprot: { baseUrl: `${base}/uniprot` }, ensembl: { baseUrl: `${base}/ensembl` }, env: {} },
    base,
  };
}

test('NCBI: search with summaries, fetch formats, key and email handling', async t => {
  const { options, requests, base } = await services(t);
  const tools = bioTools({ ...options, ncbi: { baseUrl: `${base}/eutils`, apiKey: 'secret-key', email: 'me@lab.org' } });
  const found = await call(tools, 'ncbiSearch', { db: 'gene', term: 'BRCA1[gene]' });
  assert.equal(found.count, 2);
  assert.deepEqual(found.ids, ['672', '12189']);
  assert.deepEqual([found.results[0].name, found.results[0].organism, found.results[1].organism], ['BRCA1', 'Homo sapiens', 'Mus musculus']);
  assert.ok(found.results[0].summary.length <= 401, 'long fields are shortened');
  assert.equal(found.results[0].genomicinfo, undefined, 'nested arrays are dropped');
  assert.ok(found.retrievedAt);
  assert.doesNotMatch(found.source, /secret-key/, 'the API key never appears in results');
  assert.deepEqual([requests[0].query.api_key, requests[0].query.email, requests[0].query.tool], ['secret-key', 'me@lab.org', 'lab-agent-extras']);

  const fasta = await call(tools, 'ncbiFetch', { db: 'nuccore', ids: ['NM_007294.4'] });
  assert.match(fasta.text, /\(fasta\)/);
  assert.match((await call(tools, 'ncbiFetch', { db: 'protein', ids: ['NP_009225.1'], format: 'genbank' })).text, /\(gp\)/);
  const long = await call(tools, 'ncbiFetch', { db: 'nuccore', ids: ['LONG'] });
  assert.equal(long.text.length, 20_000);
  assert.equal(long.truncated, true);
  assert.deepEqual((await call(tools, 'ncbiSearch', { db: 'gene', term: 'nothing' })).results, []);
  assert.throws(() => tools.ncbiFetch.inputSchema.parse({ db: 'nuccore', ids: ['../etc/passwd'] }));
  assert.throws(() => tools.ncbiSearch.inputSchema.parse({ db: 'not-a-db', term: 'x' }));
});

test('NCBI without a key waits about a third of a second between requests; NCBI_API_KEY is read from env', async t => {
  const { options, requests, base } = await services(t);
  const tools = bioTools({ ...options, uniprot: false, ensembl: false });
  assert.deepEqual(Object.keys(tools).sort(), ['ncbiFetch', 'ncbiSearch']);
  await call(tools, 'ncbiSearch', { db: 'gene', term: 'a' });
  await call(tools, 'ncbiSearch', { db: 'gene', term: 'b' });
  const times = requests.map(request => request.at);
  for (let index = 1; index < times.length; index++) assert.ok(times[index] - times[index - 1] >= 300, `gap ${times[index] - times[index - 1]} ms`);
  assert.equal(requests[0].query.api_key, undefined);
  const keyed = bioTools({ ...options, ncbi: { baseUrl: `${base}/eutils` }, env: { NCBI_API_KEY: 'env-key' } });
  await call(keyed, 'ncbiFetch', { db: 'nuccore', ids: ['X1'] });
  assert.equal(requests.at(-1).query.api_key, 'env-key');
});

test('UniProt: search fields, entry formats and errors', async t => {
  const { options, requests } = await services(t);
  const tools = bioTools(options);
  const found = await call(tools, 'uniprotSearch', { query: 'gene:TP53 AND organism_id:9606' });
  assert.deepEqual(found.results, [{ accession: 'P04637', entryName: 'P53_HUMAN', reviewed: true, protein: 'Cellular tumor antigen p53', genes: ['TP53'], organism: 'Homo sapiens', length: 393 }]);
  assert.equal(requests[0].query.size, '10');
  assert.match((await call(tools, 'uniprotEntry', { accession: 'P04637' })).text, /^>sp\|P04637/);
  await assert.rejects(call(tools, 'uniprotEntry', { accession: 'NOPE' }), /UniProt returned 404: \["Resource not found"\]/);
});

test('Ensembl: lookup by symbol, sequence types, errors and a 429 retry', async t => {
  const { options } = await services(t);
  const tools = bioTools(options);
  const gene = await call(tools, 'ensemblLookup', { symbol: 'TP53' });
  assert.deepEqual([gene.id, gene.biotype, gene.start, gene.assembly_name, gene.internal], ['ENSG00000141510', 'protein_coding', 7661779, 'GRCh38', undefined]);
  assert.match((await call(tools, 'ensemblSequence', { id: 'ENSG00000141510', type: 'cds' })).text, /cds\nGATTACA/);
  await assert.rejects(call(tools, 'ensemblLookup', { symbol: 'FAKE' }), /Ensembl returned 400: No valid lookup found/);
  assert.equal((await call(tools, 'ensemblLookup', { id: 'ENSGRATE' })).biotype, 'lncRNA');
  assert.throws(() => tools.ensemblLookup.inputSchema.parse({ symbol: 'TP53', id: 'ENSG1' }), /exactly one/);
  assert.throws(() => tools.ensemblLookup.inputSchema.parse({ symbol: 'TP53', species: '../x' }));
  assert.throws(() => bioTools({ ncbi: false, uniprot: false, ensembl: false }), /turned off/);
});
