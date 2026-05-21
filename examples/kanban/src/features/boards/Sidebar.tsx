/**
 * Left sidebar. Lists boards, switches between them, exposes a collapse
 * toggle (the collapsed width is wide enough to keep the brand mark visible).
 */

import { use, useRoot } from '@kontsedal/olas-react'
import { ChevronsLeft, ChevronsRight, Sparkles } from 'lucide-react'
import type { AppApi } from '../../app.controller'
import { cx, IconButton, Skeleton } from '../../ui'

export function Sidebar() {
  const app = useRoot<AppApi>()
  const boards = use(app.boards.list.data)
  const isLoading = use(app.boards.list.isLoading)
  const active = use(app.boards.activeBoardId)
  const prefs = use(app.preferences.prefs)
  const collapsed = prefs.sidebarCollapsed

  return (
    <aside className={cx('olas-sidebar', collapsed && 'olas-sidebar-collapsed')}>
      <div className="olas-sidebar-brand">
        <span className="olas-sidebar-mark" aria-hidden>
          <Sparkles size={18} />
        </span>
        {!collapsed && (
          <span className="olas-sidebar-title">
            Olas <span className="olas-sidebar-sub">/ Kanban</span>
          </span>
        )}
        <IconButton
          size="sm"
          label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={app.preferences.toggleSidebar}
          className="olas-sidebar-collapse"
        >
          {collapsed ? <ChevronsRight size={14} /> : <ChevronsLeft size={14} />}
        </IconButton>
      </div>

      {!collapsed && <div className="olas-sidebar-section">Boards</div>}

      <nav className="olas-sidebar-list" aria-label="Boards">
        {isLoading && boards === undefined ? (
          <>
            <Skeleton height={32} />
            <Skeleton height={32} />
          </>
        ) : boards === undefined ? null : (
          boards.map((b) => {
            const isActive = b.id === active
            const style = { ['--board-hue' as string]: String(b.hue) } as React.CSSProperties
            return (
              <button
                type="button"
                key={b.id}
                style={style}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => app.boards.setActive(b.id)}
                className={cx('olas-sidebar-board', isActive && 'olas-sidebar-board-active')}
              >
                <span className="olas-sidebar-board-dot" aria-hidden />
                {!collapsed && <span className="olas-sidebar-board-name">{b.name}</span>}
              </button>
            )
          })
        )}
      </nav>

      <div className="olas-sidebar-spacer" />

      {!collapsed && (
        <div className="olas-sidebar-foot">
          <span className="olas-kbd">cmd K</span>
          <span className="olas-sidebar-foot-text">to focus search</span>
        </div>
      )}
    </aside>
  )
}
