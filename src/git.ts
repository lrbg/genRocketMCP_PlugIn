import * as vscode from 'vscode'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import * as os from 'os'

const pexec = promisify(execFile)

export interface Repo { fullName: string; name: string; owner: string; defaultBranch: string; isPrivate: boolean }

/** Sesión de GitHub del propio usuario (VS Code gestiona el login y el token). */
export async function getSession(createIfNone: boolean): Promise<vscode.AuthenticationSession | undefined> {
  return vscode.authentication.getSession('github', ['repo'], { createIfNone })
}

export async function listRepos(token: string): Promise<Repo[]> {
  const all: Repo[] = []
  const seen = new Set<string>()
  // Trae TODAS las páginas (hasta 20 = 2000 repos) y de las dos rutas útiles.
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(
      `https://api.github.com/user/repos?per_page=100&page=${page}&sort=full_name&affiliation=owner,collaborator,organization_member`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
    )
    if (!res.ok) { throw new Error(`GitHub API ${res.status}`) }
    const arr = (await res.json()) as any[]
    for (const r of arr) {
      if (seen.has(r.full_name)) { continue }
      seen.add(r.full_name)
      all.push({ fullName: r.full_name, name: r.name, owner: r.owner.login, defaultBranch: r.default_branch, isPrivate: r.private })
    }
    if (arr.length < 100) { break }
  }
  all.sort((a, b) => a.fullName.localeCompare(b.fullName))
  return all
}

export async function listApiBranches(token: string, owner: string, name: string): Promise<string[]> {
  const out: string[] = []
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${name}/branches?per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
    )
    if (!res.ok) { break }
    const arr = (await res.json()) as any[]
    for (const b of arr) { out.push(b.name) }
    if (arr.length < 100) { break }
  }
  return out
}

function authArgs(token?: string): string[] {
  if (!token) { return [] }
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  return ['-c', `http.extraheader=AUTHORIZATION: Basic ${basic}`]
}

async function git(cwd: string, args: string[], token?: string) {
  return pexec('git', [...authArgs(token), ...args], { cwd, maxBuffer: 20 * 1024 * 1024 })
}

/** Carpeta base donde clonar (workspace abierto, o ~/GenRocketRepos). */
export function cloneBaseDir(): string {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  return ws || path.join(os.homedir(), 'GenRocketRepos')
}

/** Busca entre las carpetas abiertas una cuyo origin sea owner/name. */
export async function findLocalRepo(owner: string, name: string): Promise<string | null> {
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const dir = f.uri.fsPath
    const r = await remoteOwnerRepo(dir)
    if (r && r.owner.toLowerCase() === owner.toLowerCase() && r.name.toLowerCase() === name.toLowerCase()) { return dir }
  }
  return null
}

export async function cloneRepo(token: string, owner: string, name: string, targetBase: string): Promise<string> {
  await pexec('git', [...authArgs(token), 'clone', `https://github.com/${owner}/${name}.git`], { cwd: targetBase, maxBuffer: 50 * 1024 * 1024 })
  return path.join(targetBase, name)
}

export async function remoteOwnerRepo(dir: string): Promise<{ owner: string; name: string } | null> {
  try {
    const { stdout } = await git(dir, ['remote', 'get-url', 'origin'])
    const m = stdout.trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/)
    return m ? { owner: m[1], name: m[2] } : null
  } catch { return null }
}

export async function currentBranch(dir: string): Promise<string> {
  const { stdout } = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return stdout.trim()
}

export async function listBranches(dir: string): Promise<string[]> {
  const { stdout } = await git(dir, ['branch', '--format=%(refname:short)'])
  return stdout.split('\n').map(s => s.trim()).filter(Boolean)
}

export async function checkout(dir: string, branch: string, create: boolean): Promise<void> {
  await git(dir, create ? ['checkout', '-b', branch] : ['checkout', branch])
}

export async function changedFiles(dir: string): Promise<string[]> {
  const { stdout } = await git(dir, ['status', '--porcelain'])
  return stdout.split('\n').map(s => s.trim()).filter(Boolean)
}

export async function commitAndPush(
  dir: string, message: string, branch: string, token: string, name: string, email: string,
): Promise<void> {
  await git(dir, ['add', '-A'])
  await git(dir, ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-m', message])
  await git(dir, ['push', '-u', 'origin', `HEAD:${branch}`], token)
}

export function defaultAuthor(session: vscode.AuthenticationSession): { name: string; email: string } {
  const login = session.account.label
  return { name: login, email: `${login}@users.noreply.github.com` }
}
