import { spawn } from 'node:child_process';
import os from 'node:os';
import pc from 'picocolors';
import { APP_NAME } from '../constants.js';
import { out } from './render.js';
import { writeGlobalConfig } from './setup.js';

export const DEFAULT_GATEWAY_URL = 'https://coder.datacademy.uz';
export const GATEWAY_PROVIDER_NAME = 'datacademy';

export function gatewayUrl(): string {
  return (process.env.DATACADEMY_GATEWAY_URL ?? DEFAULT_GATEWAY_URL).replace(/\/+$/, '');
}

function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* user can open the link manually */
  }
}

interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

/**
 * Device-code login against the DataCademy gateway. Returns true when a config was written.
 */
export async function runLogin(signal?: AbortSignal): Promise<boolean> {
  const base = gatewayUrl();
  out(`\n${pc.bold(pc.magenta('DataCademy hisobiga ulanish'))} ${pc.dim(base)}\n`);
  let start: DeviceStart;
  try {
    const res = await fetch(`${base}/cli/device`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostname: os.hostname() }), signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    start = (await res.json()) as DeviceStart;
  } catch (err) {
    out(`${pc.red(`✗ ${base} bilan bog'lanib bo'lmadi: ${(err as Error).message}`)}\n`);
    return false;
  }
  const link = start.verification_uri_complete ?? start.verification_uri;
  out(`\n  Brauzerda oching: ${pc.cyan(link)}\n`);
  out(`  Kod: ${pc.bold(pc.green(start.user_code))}\n\n`);
  out(pc.dim('  tasdiqlanishini kutyapman (Ctrl+C — bekor)...\n'));
  openBrowser(link);

  const deadline = Date.now() + (start.expires_in ?? 600) * 1000;
  const interval = Math.max(2, start.interval ?? 3) * 1000;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    await new Promise((r) => setTimeout(r, interval));
    let data: { status: string; api_key?: string; base_url?: string; model?: string };
    try {
      const res = await fetch(`${base}/cli/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_code: start.device_code }), signal });
      data = (await res.json()) as typeof data;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return false;
      continue; // transient network error, keep polling
    }
    if (data.status === 'pending') continue;
    if (data.status !== 'ok' || !data.api_key) {
      out(`${pc.red(`✗ login bekor qilindi (${data.status})`)}\n`);
      return false;
    }
    const baseUrl = data.base_url ?? `${base}/v1`;
    const model = data.model ?? 'datacademy-max';
    const file = writeGlobalConfig(GATEWAY_PROVIDER_NAME, {
      [GATEWAY_PROVIDER_NAME]: { type: 'openai', baseUrl, apiKey: data.api_key, model, contextWindow: 131072, temperature: 0.1, maxTokens: 8192 },
    });
    out(`\n${pc.green('✓')} ulandi ${pc.dim(`(config: ${file})`)}\n`);
    // Show the account state right away so "model" is not mistaken for the plan.
    try {
      const res = await fetch(`${baseUrl}/usage`, { headers: { authorization: `Bearer ${data.api_key}` }, signal });
      if (res.ok) {
        const u = (await res.json()) as Record<string, unknown>;
        const n = (v: unknown) => Number(v ?? 0).toLocaleString('ru-RU');
        out(`  hisob:  ${String(u.email ?? '')}\n`);
        out(`  tarif:  ${u.plan_label ? String(u.plan_label) : "yo'q"}\n`);
        out(`  balans: ${n(u.total_remaining)} kredit${u.plan_label ? '' : ` — tarif: ${base}/pricing`}\n`);
      }
    } catch {
      /* summary is optional */
    }
    out(pc.dim(`  model: ${model} (eng kuchli) · /model datacademy-fast — arzon rejim · /usage — balans\n`));
    return true;
  }
  out(`${pc.red('✗ kod muddati tugadi (10 daqiqa). Qayta: ' + APP_NAME + ' login')}\n`);
  return false;
}
