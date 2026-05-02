import { spawn, execFileSync } from 'child_process'
import { existsSync } from 'fs'

const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

// Resolve cloudflared once at module load. Defense-in-depth against PATH
// surprises in launchd / non-interactive contexts:
//   - Bare-name spawn('cloudflared', ...) uses the inherited env PATH for
//     name lookup. Under launchd that PATH is whatever the wrapper exports;
//     under a non-interactive shell (tmux's default panes) it may not include
//     /opt/homebrew/bin even when the parent had it.
//   - The 2026-05-02 Mac Mini failure cascade (BrightEndospine
//     context/next-session.md "Failure cascade" #5) included a concrete
//     instance: Bun.spawn could not find cloudflared from inside a tmux pane
//     until PATH was inlined.
//   - We prefer an absolute path when available, and fall back to bare-name
//     lookup only if no known location resolves. This way:
//       * Dev machines with cloudflared at /opt/homebrew/bin (Apple Silicon)
//         or /usr/local/bin (Intel) work even with a degraded PATH.
//       * CI / containers / unusual installs still work via bare-name
//         fallback.
function resolveCloudflared(): string {
  const candidates = [
    '/opt/homebrew/bin/cloudflared', // Apple Silicon Homebrew
    '/usr/local/bin/cloudflared', // Intel Homebrew + many manual installs
  ]
  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  // Last resort: bare name. spawn() will surface a clear ENOENT if PATH
  // lookup fails — better than silently hanging on the URL-match timeout.
  return 'cloudflared'
}

const CLOUDFLARED_BIN = resolveCloudflared()

// Kill any existing cloudflared tunnel processes to avoid port/URL conflicts
function killExistingTunnels(): void {
  try {
    execFileSync('pkill', ['-f', 'cloudflared tunnel'], { stdio: 'ignore' })
    // Brief wait for processes to actually die
    Bun.sleepSync(1000)
  } catch {
    // No existing processes, that's fine
  }
}

export function startTunnel(port: number): Promise<{ url: string; kill: () => void }> {
  killExistingTunnels()

  return new Promise((resolve, reject) => {
    const proc = spawn(CLOUDFLARED_BIN, ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let resolved = false
    const timeout = setTimeout(() => {
      if (!resolved) {
        reject(new Error('[tunnel] Timed out waiting for tunnel URL (30s)'))
        proc.kill()
      }
    }, 30_000)

    function handleOutput(data: Buffer) {
      const text = data.toString()
      const match = text.match(TUNNEL_URL_PATTERN)
      if (match && !resolved) {
        resolved = true
        clearTimeout(timeout)
        resolve({
          url: match[0],
          kill: () => proc.kill(),
        })
      }
    }

    proc.stdout.on('data', handleOutput)
    proc.stderr.on('data', handleOutput)

    proc.on('error', (err) => {
      if (!resolved) {
        clearTimeout(timeout)
        reject(new Error(`[tunnel] Failed to start cloudflared: ${err.message}`))
      }
    })

    proc.on('exit', (code) => {
      if (!resolved) {
        clearTimeout(timeout)
        reject(new Error(`[tunnel] cloudflared exited with code ${code}`))
      }
    })
  })
}
