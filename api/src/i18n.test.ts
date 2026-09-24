import { describe, it, expect } from 'vitest';
import { EN_MESSAGES, translateMessage, detectLang, localizeResponse } from './i18n';
// @ts-ignore — import de texto puro do Vite (sem tipos no tsconfig da API)
import indexSrc from './index.ts?raw';
// @ts-ignore
import panelAccessSrc from './panel-access.ts?raw';
// @ts-ignore
import panelMembersSrc from './panel-members.ts?raw';

// Mesma extração usada para montar o dicionário: literais passados a fail()/ok()/res()
// e `reason:` do painel. Se alguém criar uma mensagem em pt-BR nova sem traduzir, falha aqui.
const STR = "('(?:[^'\\\\]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`)";
const CALL = new RegExp("(?:fail|ok|res)\\(\\s*(?:ResponseCodes\\.\\w+|'[A-Z_]+'|\\d+)(?:\\s*,\\s*'[A-Z_]+')?\\s*,\\s*" + STR, 'g');
const REASON = new RegExp('reason: ' + STR, 'g');

function messagesIn(src: string): string[] {
  const out: string[] = [];
  for (const re of [CALL, REASON]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) out.push(m[1]);
  }
  return out;
}

const HAS_PT = /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]|obrigat[óo]ri/;

describe('i18n da API', () => {
  it('toda mensagem em português da API tem tradução em inglês', () => {
    const missing: string[] = [];
    for (const src of [indexSrc, panelAccessSrc, panelMembersSrc] as string[]) {
      for (const literal of messagesIn(src)) {
        if (literal.startsWith('`')) continue; // mensagens dinâmicas: cobertas por EN_PATTERNS (testadas abaixo)
        const message = literal.slice(1, -1).replace(/\\'/g, "'");
        if (!HAS_PT.test(message)) continue; // 'ok', 'OK', 'SUCCESS'...
        if (!(message in EN_MESSAGES)) missing.push(message);
      }
    }
    expect(missing).toEqual([]);
  });

  it('traduz por dicionário e por padrão, e mantém o original se desconhecido', () => {
    expect(translateMessage('Servidor não encontrado.', 'en')).toBe('Server not found.');
    expect(translateMessage('Servidor não encontrado.', 'pt')).toBe('Servidor não encontrado.');
    expect(translateMessage('O comando "say" não está na sua lista de comandos permitidos.', 'en'))
      .toBe('The command "say" isn\'t in your list of allowed commands.');
    expect(translateMessage('Limite de 10 membros/convites por computador atingido. Remova algum antes de convidar mais.', 'en'))
      .toBe('Limit of 10 members/invites per computer reached. Remove one before inviting more.');
    expect(translateMessage('mensagem desconhecida', 'en')).toBe('mensagem desconhecida');
  });

  it('detecta o idioma pelo Accept-Language', () => {
    const req = (h?: string) => new Request('https://x.test', h ? { headers: { 'Accept-Language': h } } : undefined);
    expect(detectLang(req('en-US,en;q=0.9'))).toBe('en');
    expect(detectLang(req('pt-BR'))).toBe('pt');
    expect(detectLang(req())).toBe('pt');
  });

  it('localizeResponse traduz só o campo message de respostas JSON em inglês', async () => {
    const original = () => new Response(JSON.stringify({ success: false, code: 'SERVER_NOT_FOUND', message: 'Servidor não encontrado.' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
    const en = await localizeResponse(new Request('https://x.test', { headers: { 'Accept-Language': 'en' } }), original());
    expect(en.status).toBe(404);
    expect(en.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await en.json()).toMatchObject({ code: 'SERVER_NOT_FOUND', message: 'Server not found.' });

    const pt = await localizeResponse(new Request('https://x.test'), original());
    expect(await pt.json()).toMatchObject({ message: 'Servidor não encontrado.' });
  });
});
