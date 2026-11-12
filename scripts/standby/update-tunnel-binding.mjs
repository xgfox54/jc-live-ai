// Points the Worker's JC_LAPTOP_URL binding at the current quick tunnel address; other bindings are inherited.
// Reads JC_LAPTOP_TUNNEL_URL, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN from the environment.
const endpoint = process.env.JC_LAPTOP_TUNNEL_URL;
if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(endpoint ?? '')) throw new Error('Invalid laptop tunnel URL');
const api = 'https://api.cloudflare.com/client/v4/accounts/' + process.env.CLOUDFLARE_ACCOUNT_ID + '/workers/scripts/jc-live/settings';
const headers = { Authorization: 'Bearer ' + process.env.CLOUDFLARE_API_TOKEN };
const current = await fetch(api, { headers });
if (!current.ok) throw new Error('Worker settings unavailable: ' + current.status);
const bindings = (await current.json()).result.bindings;
if (!bindings.some(binding => binding.name === 'JC_LAPTOP_URL')) throw new Error('Laptop binding missing');
const form = new FormData();
form.set('settings', JSON.stringify({ bindings: bindings.map(binding => binding.name === 'JC_LAPTOP_URL'
  ? { name: binding.name, type: 'plain_text', text: endpoint } : { name: binding.name, type: 'inherit' }) }));
const updated = await fetch(api, { method: 'PATCH', headers, body: form });
if (!updated.ok) throw new Error('Tunnel binding update HTTP ' + updated.status + ': ' + JSON.stringify((await updated.json()).errors));
