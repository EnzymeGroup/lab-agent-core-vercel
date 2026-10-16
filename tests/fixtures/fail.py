import sys
print('deterministic Python failure', file=sys.stderr)
raise SystemExit(7)
