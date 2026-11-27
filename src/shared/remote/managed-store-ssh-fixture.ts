import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface SshFixtureControl {
    recoveryFaultPath?: string;
    disabledSshLogPath?: string;
}

export async function writeManagedStoreSshFixture(
    bin: string,
    remoteHome: string,
    control?: SshFixtureControl,
): Promise<void> {
    // Replace only OpenSSH transport. Its reply comes from the real remote private entry in another process.
    const configuration = {
        bun: process.execPath,
        cli: new URL("../../cli.ts", import.meta.url).pathname,
        remoteHome,
        ...control,
    };
    await writeFile(
        join(bin, "ssh"),
        `#!/usr/bin/env python3
import json, os, subprocess, sys
config = json.loads(${JSON.stringify(JSON.stringify(configuration))})
disabled_log = config.get('disabledSshLogPath')
if disabled_log and os.path.isfile(disabled_log):
    with open(disabled_log, 'a') as f:
        f.write('ssh\\n')
    sys.exit(255)
request = json.loads(sys.stdin.readline())
env = dict(os.environ, HOME=config['remoteHome'], WLD_TEST_SANDBOX_HOME=config['remoteHome'], MNEMOTECA_DB_PATH=os.path.join(config['remoteHome'], 'mnemoteca.db'))
key = 'transfer' if 'transfer' in request else 'proof' if 'proof' in request else 'admission'
flag = '--remote-runtime-transfer' if key == 'transfer' else '--remote-publication-proof' if key == 'proof' else '--remote-project-admission'
fault_path = config.get('recoveryFaultPath')
distort_recovery = fault_path and key == 'proof' and 'recovery' in request[key] and os.path.isfile(fault_path)
result = subprocess.run([config['bun'], config['cli'], flag], input=json.dumps(request[key]) + '\\n', text=True, env=env, stdout=subprocess.PIPE if distort_recovery else None)
if distort_recovery and result.returncode == 0:
    with open(fault_path) as f:
        fault = json.load(f)
    evidence = json.loads(result.stdout)
    evidence[fault['section']][fault['field']] = fault['value']
    print(json.dumps(evidence))
sys.exit(result.returncode)
`,
    );
    await chmod(join(bin, "ssh"), 0o700);
}
