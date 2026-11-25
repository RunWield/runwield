import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function writeManagedStoreSshFixture(bin: string, remoteHome: string): Promise<void> {
    // Replace only OpenSSH transport. Its reply comes from the real remote private entry in another process.
    const configuration = {
        bun: process.execPath,
        cli: new URL("../../cli.ts", import.meta.url).pathname,
        remoteHome,
    };
    await writeFile(
        join(bin, "ssh"),
        `#!/usr/bin/env python3
import json, os, subprocess, sys
config = json.loads(${JSON.stringify(JSON.stringify(configuration))})
request = json.loads(sys.stdin.readline())
env = dict(os.environ, HOME=config['remoteHome'], WLD_TEST_SANDBOX_HOME=config['remoteHome'], MNEMOTECA_DB_PATH=os.path.join(config['remoteHome'], 'mnemoteca.db'))
key = 'transfer' if 'transfer' in request else 'proof' if 'proof' in request else 'admission'
flag = '--remote-runtime-transfer' if key == 'transfer' else '--remote-publication-proof' if key == 'proof' else '--remote-project-admission'
result = subprocess.run([config['bun'], config['cli'], flag], input=json.dumps(request[key]) + '\\n', text=True, env=env)
sys.exit(result.returncode)
`,
    );
    await chmod(join(bin, "ssh"), 0o700);
}
