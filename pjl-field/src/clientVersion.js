// The running bundle's identity, read once. See clientVersionInfo.mjs for why.
import * as Updates from 'expo-updates';
import buildInfo from './buildInfo.json';
import { describeClientVersion, clientVersionLines, clientVersionHeaderValue } from './clientVersionInfo.mjs';

let cached = null;
export function clientVersion() {
  if (cached) return cached;
  try {
    cached = describeClientVersion(buildInfo, {
      isEmbeddedLaunch: Updates.isEmbeddedLaunch,
      updateId: Updates.updateId,
      runtimeVersion: Updates.runtimeVersion,
      channel: Updates.channel,
      createdAt: Updates.createdAt,
    });
  } catch {
    cached = describeClientVersion(buildInfo, {});
  }
  return cached;
}

export const clientVersionText = () => clientVersionLines(clientVersion());
export const clientVersionHeader = () => clientVersionHeaderValue(clientVersion());
