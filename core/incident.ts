/** Report a failure without logging request data or backend error text. */
export function incident(stage: 'request' | 'authentication' | 'cors' | 'runtime' | 'poll' | 'shutdown', category: 'internal' | 'configuration' | 'storage' | 'panic'): string {
  const incident_id = crypto.randomUUID();
  console.error(JSON.stringify({ stage, category, incident_id }));
  return incident_id;
}
