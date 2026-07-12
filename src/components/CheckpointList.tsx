// Checkpoint list for a task detail view — rows toggle done-state via
// useToggleCheckpoint() (persists per-board tasks.json, refreshes the cache).
// Header shows done/total + ProgressBar; each row uses the pre-made .checkpoint classes.
import { Icon } from '#/lib/icons'
import { ProgressBar } from '#/components/primitives'
import { useCanEdit, useToggleCheckpoint } from '#/lib/board-query'
import type { TaskView } from '#/lib/tasks'

export function CheckpointList({ task }: { task: TaskView }) {
  const toggle = useToggleCheckpoint()
  const canEdit = useCanEdit()

  return (
    <div className="card">
      <div className="card-head">
        <Icon name="check" className="nav-ico" />
        <h3>Checkpoints</h3>
        <span className="count">
          {task.done}/{task.total} done
        </span>
        <div style={{ flex: 1, maxWidth: 160, marginLeft: 'auto' }}>
          <ProgressBar pct={task.pct} ok={task.pct === 100} />
        </div>
      </div>
      <div className="card-body">
        {task.checkpoints.length ? (
          task.checkpoints.map((c) => (
            <div
              key={c.id}
              className={`checkpoint ${c.done ? 'done' : ''}`}
              role={canEdit ? 'button' : undefined}
              aria-disabled={toggle.isPending}
              style={{ cursor: canEdit ? 'pointer' : 'default' }}
              onClick={() => {
                if (!canEdit || toggle.isPending) return
                toggle.mutate({ taskId: task.id, checkpointId: c.id })
              }}
            >
              <span className="box">{c.done ? <Icon name="check" /> : null}</span>
              <span className="cp-label">{c.label}</span>
              {c.category ? <span className="cp-cat">{c.category}</span> : null}
            </div>
          ))
        ) : (
          <div className="empty">No checkpoints listed.</div>
        )}
      </div>
    </div>
  )
}
