import type {NodeType} from '../permits.ts';
import type {Feature} from './feature.ts';
import {app, subscriptions} from './app.ts';
import {children, runners, workspace} from './management.ts';
import {effectivePermissions, lifecycle, memberships, node, permissions, profile, team, user} from './nodes.ts';

export type {Feature} from './feature.ts';

// A type implements a whole service. Shared descriptors and their validators
// are built once, so the same service version has the same contract everywhere.
const managedNode = [node, lifecycle, permissions, effectivePermissions, memberships];
const services: Record<NodeType, Record<string, Feature>[]> = {
  workspace: [workspace, children, runners],
  team: [node, permissions, children, team],
  user: [...managedNode, user],
  app: [...managedNode, subscriptions, app],
  profile: [...managedNode, profile],
};

export function systemContract(type: NodeType): Map<string, Feature> {
  const features = new Map<string, Feature>();
  for (const service of services[type]) {
    for (const [name, feature] of Object.entries(service)) features.set(name, feature);
  }
  return features;
}
