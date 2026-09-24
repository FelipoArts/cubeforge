// Localização das mensagens da API.
//
// O código da API responde `{ code, message }` com `message` em português (fonte de
// verdade — ver fail()/ok()/res()). Clientes em inglês mandam `Accept-Language: en...`
// e recebem a mesma resposta com `message` traduzida por este dicionário, aplicado num
// único ponto (localizeResponse, no fetch principal) — sem tocar nas dezenas de
// call-sites. O `code` nunca muda, então clientes podem continuar decidindo por ele.
//
// Ao criar uma mensagem nova em português na API, acrescente a tradução aqui: o teste
// i18n.test.ts falha se algum `fail(...)/ok(...)/res(...)` ficar sem tradução.

export type Lang = 'pt' | 'en';

export function detectLang(req: Request): Lang {
  const header = (req.headers.get('Accept-Language') || '').trim().toLowerCase();
  return header.startsWith('en') ? 'en' : 'pt';
}

const SLUG_RULE_EN = 'use 3 to 32 lowercase letters, numbers or hyphens, with no hyphen at the ends.';

export const EN_MESSAGES: Record<string, string> = {
  // ---- API principal ----
  'Muitas tentativas. Aguarde um minuto e tente de novo.': 'Too many attempts. Wait a minute and try again.',
  'Heartbeat recebido.': 'Heartbeat received.',
  'JSON inválido.': 'Invalid JSON.',
  'name, version, serverType obrigatórios.': 'name, version, serverType are required.',
  'Servidor criado.': 'Server created.',
  'Servidor não encontrado.': 'Server not found.',
  'Servidor encontrado.': 'Server found.',
  'Servidor removido.': 'Server removed.',
  'Código regenerado.': 'Code regenerated.',
  'Pedido de despertar já enviado recentemente. Aguarde alguns segundos.': 'A wake request was already sent recently. Wait a few seconds.',
  'Pedido de despertar enviado.': 'Wake request sent.',
  'requestId obrigatório.': 'requestId is required.',
  'correlationId, clientVersion, installationId obrigatórios.': 'correlationId, clientVersion, installationId are required.',
  'mode precisa ser "host" ou "guest".': 'mode must be "host" or "guest".',
  'Sessão já ativa para este servidor.': 'A session is already active for this server.',
  'Não foi possível gerar as credenciais de rede. Tente novamente em instantes.': "Couldn't generate the network credentials. Please try again in a moment.",
  'Sessão criada.': 'Session created.',
  'Sessão não encontrada.': 'Session not found.',
  'Revisão desatualizada.': 'Outdated revision.',
  'Sessão atualizada.': 'Session updated.',
  'Sessão já não existe.': 'The session no longer exists.',
  'Sessão encerrada.': 'Session ended.',
  'Endpoint CurseForge não permitido.': 'CurseForge endpoint not allowed.',
  'Import de modpacks CurseForge não está configurado neste servidor.': "CurseForge modpack import isn't configured on this server.",
  'Falha ao contatar a CurseForge.': 'Failed to contact CurseForge.',
  'Doações não estão configuradas neste servidor.': "Donations aren't configured on this server.",
  'Falha ao contatar o Stripe.': 'Failed to contact Stripe.',
  'Não foi possível criar a sessão de pagamento.': "Couldn't create the payment session.",
  'Sessão de checkout criada.': 'Checkout session created.',
  'Assinaturas não estão configuradas neste servidor.': "Subscriptions aren't configured on this server.",
  'Não autenticado.': 'Not signed in.',
  'plan precisa ser "monthly" ou "annual".': 'plan must be "monthly" or "annual".',
  'Não foi possível criar a sessão de assinatura.': "Couldn't create the subscription session.",
  'Portal de assinatura não está configurado neste servidor.': "The subscription portal isn't configured on this server.",
  'Nenhuma assinatura encontrada.': 'No subscription found.',
  'Não foi possível abrir o portal de assinatura.': "Couldn't open the subscription portal.",
  'Sessão de portal criada.': 'Portal session created.',
  'Webhook do Stripe não está configurado.': "The Stripe webhook isn't configured.",
  'Assinatura do webhook inválida.': 'Invalid webhook signature.',
  'Payload inválido.': 'Invalid payload.',
  'Assine o Cubicase Plus para usar um link de convite personalizado.': 'Subscribe to Cubicase Plus to use a custom invite link.',
  'Link inválido — use 3 a 32 letras minúsculas, números ou hífen, sem hífen nas pontas.': `Invalid link — ${SLUG_RULE_EN}`,
  'Esse link já está em uso. Escolha outro.': 'That link is already in use. Choose another one.',
  'Link de convite atualizado.': 'Invite link updated.',
  'Link de convite removido.': 'Invite link removed.',
  'Assine o Cubicase Plus para usar um endereço de conexão personalizado.': 'Subscribe to Cubicase Plus to use a custom connection address.',
  'Endereço inválido — use 3 a 32 letras minúsculas, números ou hífen, sem hífen nas pontas.': `Invalid address — ${SLUG_RULE_EN}`,
  'Esse endereço já está em uso. Escolha outro.': 'That address is already in use. Choose another one.',
  'Endereço de conexão atualizado.': 'Connection address updated.',
  'Endereço de conexão removido.': 'Connection address removed.',
  'Link de convite não encontrado.': 'Invite link not found.',
  'Link resolvido.': 'Link resolved.',
  'Endpoint não encontrado.': 'Endpoint not found.',
  'Erro interno.': 'Internal error.',

  // ---- Painel web: permissões / comandos (panel-access.ts) ----
  'Mensagem inválida.': 'Invalid message.',
  'Comando inválido.': 'Invalid command.',
  'Você não tem permissão para desligar o servidor.': "You don't have permission to stop the server.",
  'Você não tem permissão para rodar comandos.': "You don't have permission to run commands.",
  'Você não tem permissão para ligar o servidor.': "You don't have permission to start the server.",
  'Você não tem permissão para reiniciar o servidor.': "You don't have permission to restart the server.",
  'Servidor inválido.': 'Invalid server.',
  'Ação não suportada.': 'Unsupported action.',

  // ---- Painel web: membros e convites (panel-members.ts) ----
  'Sessão inválida ou expirada. Faça login novamente.': 'Invalid or expired session. Please sign in again.',
  'Painel web não configurado neste servidor.': "The web panel isn't configured on this server.",
  'Dispositivo não encontrado para este usuário.': 'Device not found for this user.',
  'O painel web remoto é um recurso do Cubicase Plus.': 'The remote web panel is a Cubicase Plus feature.',
  'Suas permissões neste computador estão inválidas. Peça ao dono para reconfigurá-las.': 'Your permissions on this computer are invalid. Ask the owner to reconfigure them.',
  'O dono deste computador não está com o Cubicase Plus ativo agora.': "This computer's owner doesn't have Cubicase Plus active right now.",
  'deviceId obrigatório.': 'deviceId is required.',
  'Compartilhar o painel é um recurso do Cubicase Plus.': 'Sharing the panel is a Cubicase Plus feature.',
  'Permissões inválidas.': 'Invalid permissions.',
  'kind precisa ser "email" ou "link".': 'kind must be "email" or "link".',
  'E-mail inválido.': 'Invalid email.',
  'Não existe conta do Cubicase com esse e-mail. A pessoa precisa criar a conta (fazer login uma vez) antes de ser convidada.': "There's no Cubicase account with that email. The person needs to create an account (sign in once) before being invited.",
  'Esse e-mail é da sua própria conta.': 'That email belongs to your own account.',
  'Essa conta já tem acesso a este computador.': 'That account already has access to this computer.',
  'Não foi possível criar o convite.': "Couldn't create the invite.",
  'Membro não encontrado.': 'Member not found.',
  'Este convite expirou, já foi usado ou não existe.': "This invite has expired, was already used, or doesn't exist.",
  'O convite tem permissões inválidas. Peça um novo ao dono.': 'The invite has invalid permissions. Ask the owner for a new one.',
  'Este computador já é seu.': 'This computer is already yours.',
  'Não foi possível aceitar o convite. Tente de novo.': "Couldn't accept the invite. Please try again.",
  'inviteId obrigatório.': 'inviteId is required.',
};

// Mensagens com trecho dinâmico.
const EN_PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^O comando "(.*)" não está na sua lista de comandos permitidos\.$/s, (m) => `The command "${m[1]}" isn't in your list of allowed commands.`],
  [/^Limite de (\d+) membros\/convites por computador atingido\. Remova algum antes de convidar mais\.$/, (m) => `Limit of ${m[1]} members/invites per computer reached. Remove one before inviting more.`],
];

/** Traduz uma mensagem em pt-BR da API. Sem tradução conhecida, devolve o original. */
export function translateMessage(message: string, lang: Lang): string {
  if (lang === 'pt') return message;
  const exact = EN_MESSAGES[message];
  if (exact) return exact;
  for (const [pattern, build] of EN_PATTERNS) {
    const match = message.match(pattern);
    if (match) return build(match);
  }
  return message;
}

/**
 * Aplica a localização a uma resposta JSON da API (campo `message`). Respostas que não
 * são JSON (WebSocket, redirecionamentos, corpo vazio) passam intactas.
 */
export async function localizeResponse(req: Request, res: Response): Promise<Response> {
  const lang = detectLang(req);
  const type = res.headers.get('Content-Type') || '';
  if (res.status === 101 || !type.includes('application/json')) return res;

  // pt-BR é a fonte: a resposta segue intacta (comportamento anterior, sem custo).
  if (lang === 'pt') return res;

  const headers = new Headers(res.headers);
  headers.append('Vary', 'Accept-Language');

  try {
    const body = (await res.clone().json()) as { message?: unknown } | null;
    if (body && typeof body === 'object' && typeof body.message === 'string') {
      body.message = translateMessage(body.message, lang);
      return new Response(JSON.stringify(body), { status: res.status, statusText: res.statusText, headers });
    }
  } catch { /* corpo não-JSON válido: devolve como veio */ }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
