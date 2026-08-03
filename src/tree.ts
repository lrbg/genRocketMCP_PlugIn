import * as vscode from 'vscode'
import * as gr from './client'

type Kind = 'project' | 'version' | 'group' | 'scenario' | 'chain' | 'domain' | 'attribute' | 'generator' | 'message'

export class GRNode extends vscode.TreeItem {
  constructor(
    public readonly kind: Kind,
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
    public readonly data?: any,
    public readonly ctx?: { project?: string; version?: string; domainId?: string },
  ) {
    super(label, collapsible)
    this.contextValue = kind
  }
}

export class GenRocketTree implements vscode.TreeDataProvider<GRNode> {
  private _onDidChange = new vscode.EventEmitter<GRNode | undefined | void>()
  readonly onDidChangeTreeData = this._onDidChange.event

  constructor(private readonly getConfig: () => Promise<gr.GenRocketConfig>) {}

  refresh(): void { this._onDidChange.fire() }

  getTreeItem(el: GRNode): vscode.TreeItem { return el }

  async getChildren(el?: GRNode): Promise<GRNode[]> {
    let cfg: gr.GenRocketConfig
    try { cfg = await this.getConfig() } catch (e: any) { return [this.msg(e.message)] }

    try {
      // Raíz → proyectos
      if (!el) {
        if (!cfg.username || !cfg.password) { return [this.msg('Configura usuario/contraseña (comando "GenRocket: Set Password")')] }
        if (!cfg.organizationId) { return [this.msg('Falta Organization ID en los ajustes de GenRocket')] }
        const projects = await gr.listProjects(cfg)
        if (!projects.length) { return [this.msg('Sin proyectos')] }
        return projects
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(p => {
            const n = new GRNode('project', p.name, vscode.TreeItemCollapsibleState.Collapsed, p)
            n.iconPath = new vscode.ThemeIcon('project')
            n.description = p.description || ''
            return n
          })
      }

      if (el.kind === 'project') {
        const p = el.data as gr.Project
        const versions = (p.projectVersions ?? []).map(v => v.versionNumber).filter(Boolean)
        const list = versions.length ? versions : ['1.0']
        return list.map(v => {
          const n = new GRNode('version', `v${v}`, vscode.TreeItemCollapsibleState.Collapsed, v, { project: p.name, version: v })
          n.iconPath = new vscode.ThemeIcon('versions')
          return n
        })
      }

      if (el.kind === 'version') {
        const c = el.ctx!
        const mk = (label: string, groupId: string, icon: string) => {
          const n = new GRNode('group', label, vscode.TreeItemCollapsibleState.Collapsed, groupId, c)
          n.iconPath = new vscode.ThemeIcon(icon)
          return n
        }
        return [mk('Escenarios', 'scenarios', 'list-unordered'), mk('Chains', 'chains', 'git-merge'), mk('Dominios', 'domains', 'symbol-structure')]
      }

      if (el.kind === 'group') {
        const c = el.ctx!
        const groupId = el.data as string
        if (groupId === 'scenarios') {
          const items = await gr.listScenarios(cfg, c.project!, c.version!)
          if (!items.length) { return [this.msg('Sin escenarios')] }
          return items.map(s => {
            const n = new GRNode('scenario', s.name, vscode.TreeItemCollapsibleState.None, s, c)
            n.iconPath = new vscode.ThemeIcon('file')
            n.tooltip = s.externalId || ''
            return n
          })
        }
        if (groupId === 'chains') {
          const items = await gr.listChains(cfg, c.project!, c.version!)
          if (!items.length) { return [this.msg('Sin chains')] }
          return items.map(ch => {
            const n = new GRNode('chain', ch.name, vscode.TreeItemCollapsibleState.None, ch, c)
            n.iconPath = new vscode.ThemeIcon('git-merge')
            n.description = ch.scenarios?.length ? `${ch.scenarios.length} escenarios` : ''
            return n
          })
        }
        // domains
        const domains = await gr.listDomains(cfg, c.project!, c.version!)
        if (!domains.length) { return [this.msg('Sin dominios')] }
        return domains.map(d => {
          const n = new GRNode('domain', d.name, vscode.TreeItemCollapsibleState.Collapsed, d, { ...c, domainId: d.externalId })
          n.iconPath = new vscode.ThemeIcon('symbol-structure')
          n.description = d.attributes?.length ? `${d.attributes.length} atributos` : ''
          n.tooltip = d.externalId
          return n
        })
      }

      if (el.kind === 'domain') {
        const d = el.data as gr.Domain
        const attrs = d.attributes ?? []
        if (!attrs.length) { return [this.msg('Sin atributos')] }
        return attrs.map(a => {
          const n = new GRNode('attribute', a.name, vscode.TreeItemCollapsibleState.Collapsed, a, el.ctx)
          n.iconPath = new vscode.ThemeIcon('symbol-field')
          return n
        })
      }

      if (el.kind === 'attribute') {
        const c = el.ctx!
        const a = el.data as gr.Attribute
        const gens = await gr.listGenerators(cfg, c.project!, c.version!, c.domainId!, a.name)
        if (!gens.length) { return [this.msg('Sin generadores')] }
        return gens.map((g: any) => {
          const n = new GRNode('generator', g.name || g.type || 'generador', vscode.TreeItemCollapsibleState.None, g, c)
          n.iconPath = new vscode.ThemeIcon('gear')
          return n
        })
      }

      return []
    } catch (e: any) {
      return [this.msg(e.message)]
    }
  }

  private msg(text: string): GRNode {
    const n = new GRNode('message', text, vscode.TreeItemCollapsibleState.None)
    n.iconPath = new vscode.ThemeIcon('info')
    return n
  }
}
