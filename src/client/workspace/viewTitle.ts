import { deskTitle } from '../taskDesk.js';
import type { WorkspaceLocation } from '../taskLocation.js';

const titles: Record<Exclude<WorkspaceLocation['view'], 'tasks'>, string> = {
  search: 'Spotlight',
  overview: 'Overview',
  waiting: 'Waiting for',
  review: 'Review',
  connections: 'Connections',
  conversations: 'Conversations',
  threads: 'Threads',
  settings: 'Settings',
  activity: 'Activity',
};

export function viewTitle(location: WorkspaceLocation) {
  return location.view === 'tasks' ? deskTitle(location) : titles[location.view];
}
