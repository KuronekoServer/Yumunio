import {startInitialWorkspaceReads} from './initial-workspace-reads.js';

// The exported Next page loads this small module while React starts. The editor
// consumes the same requests once it mounts and applies its normal validation.
startInitialWorkspaceReads(location.href);
