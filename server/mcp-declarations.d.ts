declare module '*.mjs' {
  const value: any;
  export default value;
  export const createHandler: (fetcher?: any, configLoader?: any) => (req: Request, bootstrapEnv?: Record<string, string | undefined>, ctx?: unknown) => Promise<Response>;
  export const TOOLS: any;
  export const byName: any;
  export const getVisualState: () => any;
  export const setVisualState: (incoming: any) => any;
  export const DEFAULT_NODE_BODY_COLORS: Record<string, string>;
}
