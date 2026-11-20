export const apps = ['demo', 'playpen'];
export const domains = { demo: 'https://demo.tams.lwy.sh/', playpen: 'https://playpen.tams.lwy.sh/' };
export function appName(value = 'playpen') {
  if (!apps.includes(value)) throw new Error('Choose --app=demo or --app=playpen.');
  return value;
}
export function peerURL(app) {
  const peer = app === 'demo' ? 'playpen' : 'demo';
  const url = new URL(process.env[`${peer.toUpperCase()}_URL`] ?? domains[peer]);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('App URLs must use HTTP or HTTPS.');
  return url.href;
}
export function appHTML(html, app) {
  return html.replaceAll('__PEER_URL__', peerURL(app).replaceAll('&', '&amp;').replaceAll('"', '&quot;'));
}
