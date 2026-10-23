import { spawn } from 'node:child_process';
import { createServer as createProbeServer } from 'node:net';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const serverPath = join(root, 'server.mjs');
const requestedPort = Number(process.env.PORT) || 5173;
const portCount = 21;

function validPort(port) {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

async function isThisApp(port) {
  const base = 'http://127.0.0.1:' + port;
  try {
    const health = await fetch(base + '/health', { signal: AbortSignal.timeout(800) });
    if (health.ok && (await health.json()).name === 'Options Visualizer') return true;
  } catch {}

  try {
    const page = await fetch(base + '/', { signal: AbortSignal.timeout(800) });
    const html = await page.text();
    return page.ok && html.includes('Options Visualizer') && html.includes('strategy-title');
  } catch {
    return false;
  }
}

function isPortFree(port) {
  return new Promise(resolveFree => {
    const probe = createProbeServer();
    probe.once('error', () => resolveFree(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolveFree(true)));
  });
}

function openBrowser(port) {
  const url = 'http://127.0.0.1:' + port + '/';
  const openerCommand = process.platform === 'win32'
    ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe')
    : process.platform === 'darwin'
      ? 'open'
      : 'xdg-open';
  const openerArgs = process.platform === 'win32'
    ? ['url.dll,FileProtocolHandler', url]
    : [url];
  const opener = spawn(openerCommand, openerArgs, {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: 'ignore'
  });
  opener.once('error', error => {
    console.error('Options Visualizer is running at ' + url + ', but the browser could not be opened: ' + error.message);
  });
  opener.once('exit', code => {
    if (code !== 0) console.error('Options Visualizer is running at ' + url + ', but the browser opener exited with code ' + code + '.');
  });
  opener.unref();
}

async function findPort() {
  if (!validPort(requestedPort) || requestedPort + portCount - 1 > 65535) {
    throw new Error('PORT must be a number between 1024 and 65515.');
  }

  for (let port = requestedPort; port < requestedPort + portCount; port++) {
    if (await isThisApp(port)) return { port, alreadyRunning: true };
    if (await isPortFree(port)) return { port, alreadyRunning: false };
  }

  throw new Error('No free local port was found in the range ' + requestedPort + '–' + (requestedPort + portCount - 1) + '.');
}

async function waitUntilReady(hasExited, port) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (hasExited()) return false;
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(500) });
      if (response.ok && (await response.json()).name === 'Options Visualizer') return true;
    } catch {}
    await delay(100);
  }
  return false;
}

async function main() {
  const { port, alreadyRunning } = await findPort();
  if (alreadyRunning) {
    console.log('Options Visualizer is already running on port ' + port + '.');
    openBrowser(port);
    return;
  }

  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: 'inherit',
    windowsHide: true
  });

  let childStopped = false;
  let childError = null;
  const childExit = new Promise(resolveExit => {
    child.once('exit', (code, signal) => {
      childStopped = true;
      resolveExit({ code, signal });
    });
    child.once('error', error => {
      childStopped = true;
      childError = error;
      resolveExit({ error });
    });
  });

  const stop = () => {
    if (child.exitCode === null && !child.killed) child.kill();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  if (!(await waitUntilReady(() => childStopped, port))) {
    stop();
    if (childError) throw new Error('Could not start Options Visualizer: ' + childError.message);
    throw new Error('The local server did not become ready. Check the server output above.');
  }

  console.log('Opening Options Visualizer at http://127.0.0.1:' + port + '/');
  openBrowser(port);

  const result = await childExit;
  if (result.error) throw new Error('Could not start Options Visualizer: ' + result.error.message);
  if (result.signal && !process.exitCode) process.exitCode = 0;
  else if (result.code && !process.exitCode) process.exitCode = result.code;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
