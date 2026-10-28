'use client';
// The viewfinder now lives in @throttle/ui (packages/ui/CameraScan.js) so Depot can scan with it too; this keeps
// Outpost's imports (Pack.js, CamTest.js) unchanged.
export { default } from '@throttle/ui/CameraScan.js';
