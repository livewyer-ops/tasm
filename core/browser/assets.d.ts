declare module '*.sql' { const text: string; export default text; }
declare module '*validators.js' { const validators: Record<string, (value: unknown) => boolean>; export = validators; }
