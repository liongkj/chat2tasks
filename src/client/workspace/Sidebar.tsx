import { Activity, ListTree, MessageCircle, Search, Settings2 } from 'lucide-react';
import type { Chat, Snapshot } from '../../shared/schema.js';
import { TaskFilters } from '../TaskFilters.js';
import type { WorkspaceLocation, WorkspaceView } from '../taskLocation.js';

const navItems: { view: WorkspaceView; label: string; Icon: typeof Search }[] = [
  { view: 'search', label: 'Spotlight', Icon: Search },
  { view: 'threads', label: 'Threads', Icon: ListTree },
  { view: 'conversations', label: 'Conversations', Icon: MessageCircle },
  { view: 'activity', label: 'Activity', Icon: Activity },
  { view: 'settings', label: 'Settings', Icon: Settings2 },
];

export function Sidebar({
  data,
  loaded,
  online,
  chats,
  location,
  onNavigate,
  onLocation,
}: {
  data: Snapshot;
  loaded: boolean;
  online: boolean;
  chats: Chat[];
  location: WorkspaceLocation;
  onNavigate: (view: WorkspaceView) => void;
  onLocation: (patch: Partial<WorkspaceLocation>) => void;
}) {
  const current = (view: WorkspaceView) =>
    location.view === view || (view === 'settings' && location.view === 'connections');
  return (
    <>
      <button className="brand" onClick={() => onNavigate('overview')}>
        <img src="/wawa-icon.png" width="24" height="24" alt="" /> <span>wawa</span>
      </button>
      <TaskFilters
        tasks={data.tasks}
        loaded={loaded}
        messages={data.messages}
        chats={chats}
        waits={data.waiting_for}
        pendingQuestions={data.questions.length}
        location={location}
        onLocation={onLocation}
      />
      <div className="sidebar-bottom">
        {navItems.map(({ view, label, Icon }) => (
          <button
            key={view}
            className={`nav-item ${current(view) ? 'active' : ''}`}
            aria-current={current(view) ? 'page' : undefined}
            onClick={() => onNavigate(view)}
          >
            <Icon size={16} />
            <span>{label}</span>
          </button>
        ))}
        <span
          className={`workspace-presence ${!online || data.status.error ? 'warning' : ''}`}
          title={
            !online
              ? 'Workspace unavailable'
              : (data.status.error ??
                (data.demo
                  ? 'Sample workspace'
                  : window.chat2tasksDesktop
                    ? 'Workspace on this computer'
                    : 'Workspace server available'))
          }
        >
          <span className="owner-avatar">Y</span>
          <span className="presence-copy">
            Your workspace
            <small>
              {!online
                ? 'Reconnecting…'
                : data.status.error
                  ? 'Needs attention'
                  : data.demo
                    ? 'Sample data'
                    : window.chat2tasksDesktop
                      ? 'On this computer'
                      : 'Server available'}
            </small>
          </span>
        </span>
      </div>
    </>
  );
}
