/**
 * C3-F5 / C3-R2D E2E harness fixtures — re-export surface.
 * Existing 21 specs under tests/e2e/*.spec.ts are unchanged; import from here to opt in.
 * Auth fixture: globalSetup iso clone + setup-auth storageState + mcp-auth headers.
 */
export * from './env'
export * from './auth'
export * from './auth-assert'
export * from './mcp-auth'
export * from './capture-guard'
export * from './zoom'
export * from './keyboard'
export * from './reflow'
export * from './a11y'
export * from './screenshot-manifest'
