import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Fake only the external Memory executable; RunWield routing and receipts run for real. */
export async function installMemoryProcessFixture(directory: string): Promise<string> {
    const bin = join(directory, "memory-bin");
    await mkdir(bin, { recursive: true });
    const executable = join(bin, "mnemoteca");
    await writeFile(
        executable,
        `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
path = os.environ['MNEMOTECA_DB_PATH']
if args[0] == '--help':
    print('Usage: mnemoteca'); sys.exit(0)
try:
    with open(path) as f: data = json.load(f)
except FileNotFoundError: data = []
scope = 'global' if '--global' in args else args[args.index('--name') + 1] if '--name' in args else 'default'
if args[0] == 'init': sys.exit(0)
if args[0] == 'add':
    data.append({'id': max([x['id'] for x in data] + [0]) + 1, 'scope': scope, 'content': args[-1], 'core': '--tag' in args})
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f: json.dump(data, f); f.flush(); os.fsync(f.fileno())
    print('stored'); sys.exit(0)
if args[0] == 'export':
    selected = [x for x in data if x['scope'] == scope]
    with open(args[args.index('--output') + 1], 'w') as f:
        f.write(json.dumps({'version': 1, 'collection': scope, 'doc_count': len(selected)}) + '\\n')
        for x in selected: f.write(json.dumps({'original_document_id': x['id'], 'content': x['content']}) + '\\n')
    print('Exported'); sys.exit(0)
if args[0] == 'delete':
    data = [x for x in data if x['id'] != int(args[1])]
    with open(path, 'w') as f: json.dump(data, f)
    print('deleted'); sys.exit(0)
if args[0] in ['list', 'search']:
    for entry in data:
        if entry['scope'] == scope and ('-t' not in args or entry['core']):
            print('[%s] %s' % (entry['id'], entry['content']))
    sys.exit(0)
print('Unsupported memory fixture operation', file=sys.stderr)
sys.exit(64)
`,
    );
    await chmod(executable, 0o755);
    return bin;
}
