// /api/ai-chat.js — Claude con memoria profunda y acceso total
const supabase = require('../lib/supabase');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { message, history = [], imagen_base64, user_id } = req.body;
  if (!message && !imagen_base64) return res.status(400).json({ error: 'Mensaje requerido' });

  try {
    // 1. Contexto financiero en tiempo real
    const contexto = await buildContexto(user_id);

    // 2. Cargar TODA la memoria del usuario — ordenada por importancia
    const { data: memorias } = await supabase
      .from('ai_memory')
      .select('contenido, tipo, importancia, created_at')
      .eq('user_id', user_id)
      .order('importancia', { ascending: false })
      .limit(50);

    // 3. Cargar sesiones anteriores resumidas
    const { data: sesiones } = await supabase
      .from('ia_sesiones')
      .select('resumen, created_at')
      .eq('user_id', user_id)
      .order('created_at', { ascending: false })
      .limit(5);

    const memoriaTxt = formatearMemoria(memorias || [], sesiones || []);
    const systemPrompt = buildSystemPrompt(contexto, memoriaTxt);

    // 4. Llamar a Claude
    const respuesta = await llamarClaude(systemPrompt, history, message, imagen_base64);
    const respuestaLimpia = respuesta.replace(/\[ACCION:[^\]]+\]/g, '').replace(/\[MEMORIA:[^\]]+\]/g, '').replace(/\n{3,}/g, '\n\n').trim();

    // 5. Ejecutar acciones (registrar gastos, borrar, etc.)
    const acciones = await ejecutarAcciones(respuesta, contexto, user_id);

    // 6. Extraer y guardar memorias del mensaje actual
    await extraerYGuardarMemorias(message, respuesta, user_id);

    // 7. Si la conversación tiene más de 6 mensajes, guardar resumen
    if (history.length > 0 && history.length % 6 === 0) {
      await guardarResumenSesion(history, message, respuesta, user_id);
    }

    return res.json({ ok: true, respuesta: respuestaLimpia, acciones });
  } catch (error) {
    console.error('AI chat error:', error);
    return res.status(500).json({ error: error.message });
  }
};

function formatearMemoria(memorias, sesiones) {
  const porTipo = {};
  for (const m of memorias) {
    if (!porTipo[m.tipo]) porTipo[m.tipo] = [];
    porTipo[m.tipo].push(m.contenido);
  }

  let txt = '';
  if (porTipo.perfil?.length) txt += `PERFIL: ${porTipo.perfil.join(' | ')}\n`;
  if (porTipo.objetivo?.length) txt += `OBJETIVOS: ${porTipo.objetivo.join(' | ')}\n`;
  if (porTipo.habito?.length) txt += `HÁBITOS: ${porTipo.habito.join(' | ')}\n`;
  if (porTipo.preferencia?.length) txt += `PREFERENCIAS: ${porTipo.preferencia.join(' | ')}\n`;
  if (porTipo.patron?.length) txt += `PATRONES: ${porTipo.patron.join(' | ')}\n`;
  if (porTipo.dato?.length) txt += `DATOS: ${porTipo.dato.join(' | ')}\n`;
  if (porTipo.negocio?.length) txt += `NEGOCIOS: ${porTipo.negocio.join(' | ')}\n`;
  if (porTipo.general?.length) txt += `OTROS: ${porTipo.general.join(' | ')}\n`;

  if (sesiones.length > 0) {
    txt += `\nCONVERSACIONES ANTERIORES:\n`;
    for (const s of sesiones) {
      const fecha = new Date(s.created_at).toLocaleDateString('es-CO');
      txt += `• [${fecha}] ${s.resumen}\n`;
    }
  }

  return txt || 'Sin memoria previa — primera vez que habla con el usuario.';
}

async function buildContexto(userId) {
  const uid = userId || null;
  const [
    { data: cuentas },
    { data: movsMes },
    { data: movsRecientes },
    { data: pagos },
    { data: eventos },
    { data: cajas },
    { data: metas },
    { data: recordatorios }
  ] = await Promise.all([
    supabase.from('accounts').select('*').eq('user_id', uid),
    supabase.from('movements').select('*').eq('user_id', uid)
      .gte('fecha', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0])
      .order('fecha', { ascending: false }).limit(50),
    supabase.from('movements').select('*').eq('user_id', uid)
      .order('created_at', { ascending: false }).limit(5),
    supabase.from('payments').select('*').eq('user_id', uid).neq('status', 'pagado'),
    supabase.from('events').select('*').eq('user_id', uid)
      .gte('fecha', new Date().toISOString().split('T')[0]).order('fecha').limit(10),
    supabase.from('cajas').select('*').eq('user_id', uid),
    supabase.from('metas').select('*, micrometas(*)').eq('user_id', uid).eq('estado', 'activa'),
    supabase.from('reminders').select('*').eq('user_id', uid).limit(5)
  ]);

  const totalSaldo = (cuentas || []).reduce((a, c) => a + parseFloat(c.saldo || 0), 0);
  const totalCajas = (cajas || []).reduce((a, c) => a + parseFloat(c.saldo || 0), 0);
  const ingresosMes = (movsMes || []).filter(m => m.tipo === 'ingreso').reduce((a, m) => a + parseFloat(m.monto), 0);
  const gastosMes = (movsMes || []).filter(m => m.tipo === 'gasto').reduce((a, m) => a + parseFloat(m.monto), 0);

  return { totalSaldo, totalCajas, ingresosMes, gastosMes, cuentas: cuentas || [], movimientos: movsMes || [], movsRecientes: movsRecientes || [], pagos: pagos || [], eventos: eventos || [], cajas: cajas || [], metas: metas || [], recordatorios: recordatorios || [] };
}

function buildSystemPrompt(ctx, memoria) {
  const fmt = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(n);
  const hoy = new Date().toLocaleDateString('es-CO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  return `Eres Ana, la agente financiero personal de este usuario. Tienes MEMORIA COMPLETA de todo lo que han hablado y acceso TOTAL a sus finanzas en tiempo real.

HOY: ${hoy}

═══ LO QUE SABES DE ESTE USUARIO ═══
${memoria}

═══ ESTADO FINANCIERO ACTUAL ═══
Total cuentas bancarias: ${fmt(ctx.totalSaldo)}
Total efectivo en caja: ${fmt(ctx.totalCajas)}
TOTAL DISPONIBLE: ${fmt(ctx.totalSaldo + ctx.totalCajas)}

Cuentas: ${ctx.cuentas.map(c => `${c.nombre}: ${fmt(c.saldo)}`).join(' | ') || 'ninguna'}
Cajas: ${ctx.cajas.map(c => `${c.nombre}: ${fmt(c.saldo)}`).join(' | ') || 'ninguna'}

Mes actual — Ingresos: ${fmt(ctx.ingresosMes)} | Gastos: ${fmt(ctx.gastosMes)} | Balance: ${fmt(ctx.ingresosMes - ctx.gastosMes)}

Últimos 5 movimientos:
${ctx.movsRecientes.map(m => `• ${m.tipo === 'ingreso' ? '↑' : '↓'} ${fmt(m.monto)} — ${m.descripcion} (${m.fecha}) [ID:${m.id}]`).join('\n') || 'ninguno'}

Todos los movimientos del mes:
${ctx.movimientos.map(m => `• ${m.tipo === 'ingreso' ? '+' : '-'}${fmt(m.monto)} ${m.descripcion} ${m.fecha} [ID:${m.id}]`).join('\n') || 'ninguno'}

Pagos pendientes:
${ctx.pagos.map(p => `• ${p.nombre}: ${fmt(p.monto)} — vence ${p.fecha_limite} [ID:${p.id}]`).join('\n') || 'ninguno'}

Próximos eventos:
${ctx.eventos.map(e => `• ${e.titulo} — ${e.fecha} ${e.hora || ''} [ID:${e.id}]`).join('\n') || 'ninguno'}

Metas activas:
${ctx.metas.map(m => `• ${m.titulo} — ${m.progreso || 0}% (${(m.micrometas||[]).filter(mm=>mm.completada).length}/${(m.micrometas||[]).length} pasos) [ID:${m.id}]`).join('\n') || 'ninguna'}

═══ ACCIONES DISPONIBLES (INVISIBLES AL USUARIO) ═══
Úsalas AL FINAL de tu respuesta. El usuario NUNCA las ve:
[ACCION:gasto|monto|descripcion|categoria|cuenta_id_opcional]
[ACCION:ingreso|monto|descripcion|categoria|cuenta_id_opcional]
[ACCION:pago|nombre|monto|YYYY-MM-DD]
[ACCION:evento|titulo|YYYY-MM-DD|HH:MM]
[ACCION:recordatorio|tipo|texto]
[ACCION:borrar_movimiento|ID]
[ACCION:borrar_pago|ID]
[ACCION:borrar_evento|ID]
[ACCION:meta|titulo|tipo|monto_objetivo|fecha_limite]
[ACCION:memoria|tipo|contenido|importancia_1_a_5]

═══ REGLAS DE MEMORIA ═══
- Cuando el usuario te diga su nombre → [ACCION:memoria|perfil|Se llama X|5]
- Cuando mencione negocios → [ACCION:memoria|negocio|Tiene negocio X|4]
- Cuando mencione hábitos → [ACCION:memoria|habito|descripcion|3]
- Cuando mencione metas u objetivos → [ACCION:memoria|objetivo|descripcion|4]
- Cuando notes patrones de gasto → [ACCION:memoria|patron|descripcion|3]
- Cuando diga preferencias → [ACCION:memoria|preferencia|descripcion|3]
- Guarda SIEMPRE cosas importantes que el usuario mencione

═══ REGLAS DE COMPORTAMIENTO ═══
1. NUNCA muestres [ACCION:...] al usuario — son invisibles
2. Registra gastos/ingresos INMEDIATAMENTE cuando los mencionen
3. Si dice "gasté X en Y" → [ACCION:gasto|X|Y|categoria]
4. Si dice "borrar el último gasto" → usa su ID real del listado de arriba
5. Cuando activen el micrófono → solo di "¿Qué necesitas?"
6. Respuestas CORTAS (máx 3 líneas) salvo que pida análisis
7. Confirma acciones: "✅ Registré $X en Y"
8. Habla en español colombiano, tono cálido y cercano
9. RECUERDAS TODO lo anterior — úsalo naturalmente en la conversación
10. Si te pregunta qué recuerdas → cuéntale todo lo que sabes de él
11. Aprende sus patrones y anticipa sus necesidades`;
}

async function llamarClaude(system, history, message, imagen) {
  const userContent = [];
  if (imagen) userContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imagen } });
  userContent.push({ type: 'text', text: message || 'Analiza esta imagen' });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 600,
      system,
      messages: [...history.slice(-14), { role: 'user', content: userContent }]
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.content[0].text;
}

async function extraerYGuardarMemorias(mensaje, respuesta, userId) {
  // Patrones directos para guardar sin llamar a la IA
  const patrones = [
    { regex: /me llamo ([A-Za-záéíóúÁÉÍÓÚñÑ\s]+)/i, tipo: 'perfil', fmt: m => `Se llama ${m[1].trim()}`, imp: 5 },
    { regex: /mi nombre es ([A-Za-záéíóúÁÉÍÓÚñÑ\s]+)/i, tipo: 'perfil', fmt: m => `Se llama ${m[1].trim()}`, imp: 5 },
    { regex: /tengo (\d+) años/i, tipo: 'perfil', fmt: m => `Tiene ${m[1]} años`, imp: 4 },
    { regex: /vivo en ([A-Za-záéíóúÁÉÍÓÚñÑ\s,]+)/i, tipo: 'perfil', fmt: m => `Vive en ${m[1].trim()}`, imp: 3 },
    { regex: /trabajo en|soy ([A-Za-záéíóúÁÉÍÓÚñÑ\s]+)/i, tipo: 'perfil', fmt: m => `Trabaja como/en ${m[1]?.trim()}`, imp: 3 },
    { regex: /mi negocio|tengo un negocio|mi empresa/i, tipo: 'negocio', fmt: () => `Tiene negocio(s) propios: ${mensaje.substring(0, 80)}`, imp: 4 },
    { regex: /quiero ahorrar|meta de ahorro|objetivo.*ahorr/i, tipo: 'objetivo', fmt: () => mensaje.substring(0, 100), imp: 4 },
    { regex: /siempre|normalmente|cada mes|todos los mes/i, tipo: 'habito', fmt: () => mensaje.substring(0, 100), imp: 3 },
    { regex: /prefiero|me gusta|no me gusta/i, tipo: 'preferencia', fmt: () => mensaje.substring(0, 80), imp: 2 },
  ];

  for (const p of patrones) {
    const match = mensaje.match(p.regex);
    if (match) {
      const contenido = p.fmt(match);
      if (!contenido || contenido.includes('undefined')) continue;
      const { data: existente } = await supabase.from('ai_memory').select('id').eq('user_id', userId).eq('tipo', p.tipo).ilike('contenido', `%${contenido.substring(0, 15)}%`).single().catch(() => ({ data: null }));
      if (!existente) {
        await supabase.from('ai_memory').insert({ user_id: userId, tipo: p.tipo, contenido, importancia: p.imp }).catch(() => {});
      }
    }
  }

  // Guardar memorias explícitas del [ACCION:memoria|...]
  const memoriaMatches = [...(respuesta.matchAll(/\[ACCION:memoria\|([^|]+)\|([^|]+)\|?(\d?)\]/g))];
  for (const m of memoriaMatches) {
    const tipo = m[1];
    const contenido = m[2];
    const importancia = parseInt(m[3]) || 3;
    if (!contenido) continue;
    const { data: existente } = await supabase.from('ai_memory').select('id').eq('user_id', userId).eq('tipo', tipo).ilike('contenido', `%${contenido.substring(0, 20)}%`).single().catch(() => ({ data: null }));
    if (existente) {
      await supabase.from('ai_memory').update({ contenido, importancia }).eq('id', existente.id).catch(() => {});
    } else {
      await supabase.from('ai_memory').insert({ user_id: userId, tipo, contenido, importancia }).catch(() => {});
    }
  }
}

async function guardarResumenSesion(history, ultimoMensaje, ultimaRespuesta, userId) {
  try {
    const conversacion = history.slice(-6).map(h => `${h.role === 'user' ? 'Usuario' : 'Ana'}: ${h.content}`).join('\n') + `\nUsuario: ${ultimoMensaje}\nAna: ${ultimaRespuesta}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 150,
        messages: [{ role: 'user', content: `Resume en máximo 2 líneas lo más importante de esta conversación financiera:\n${conversacion}` }]
      })
    });
    const data = await res.json();
    const resumen = data.content?.[0]?.text?.trim();
    if (resumen) {
      await supabase.from('ia_sesiones').insert({ user_id: userId, resumen, mensajes: history.length }).catch(() => {});
    }
  } catch (e) { /* silencioso */ }
}

async function ejecutarAcciones(respuesta, contexto, userId) {
  const matches = [...respuesta.matchAll(/\[ACCION:([^\]]+)\]/g)];
  const ejecutadas = [];

  for (const match of matches) {
    const parts = match[1].split('|');
    const accion = parts[0];
    try {
      if (accion === 'gasto' || accion === 'ingreso') {
        const monto = parseFloat(parts[1]);
        const desc = parts[2] || 'Sin descripción';
        const cat = parts[3] || 'otro';
        if (monto > 0) {
          const cuentaId = contexto.cuentas[0]?.id || null;
          await supabase.from('movements').insert({ user_id: userId, tipo: accion, descripcion: desc, monto, fecha: new Date().toISOString().split('T')[0], account_id: cuentaId, categoria: cat, source: 'ia' });
          if (cuentaId) {
            const cuenta = contexto.cuentas[0];
            const nuevoSaldo = accion === 'ingreso' ? parseFloat(cuenta.saldo) + monto : parseFloat(cuenta.saldo) - monto;
            await supabase.from('accounts').update({ saldo: nuevoSaldo }).eq('id', cuentaId);
          }
          ejecutadas.push({ accion, monto, desc });
        }
      } else if (accion === 'borrar_movimiento') {
        await supabase.from('movements').delete().eq('id', parts[1]).eq('user_id', userId);
        ejecutadas.push({ accion: 'borrado', tipo: 'movimiento' });
      } else if (accion === 'borrar_pago') {
        await supabase.from('payments').delete().eq('id', parts[1]).eq('user_id', userId);
        ejecutadas.push({ accion: 'borrado', tipo: 'pago' });
      } else if (accion === 'borrar_evento') {
        await supabase.from('events').delete().eq('id', parts[1]).eq('user_id', userId);
        ejecutadas.push({ accion: 'borrado', tipo: 'evento' });
      } else if (accion === 'pago') {
        await supabase.from('payments').insert({ user_id: userId, nombre: parts[1], monto: parseFloat(parts[2]), fecha_limite: parts[3], status: 'pendiente' });
        ejecutadas.push({ accion, detalle: parts[1] });
      } else if (accion === 'evento') {
        await supabase.from('events').insert({ user_id: userId, titulo: parts[1], fecha: parts[2], hora: parts[3] || null, nota: 'Creado por IA' });
        ejecutadas.push({ accion, detalle: parts[1] });
      } else if (accion === 'recordatorio') {
        await supabase.from('reminders').insert({ user_id: userId, tipo: parts[1] || 'nota', titulo: parts[2], content: { texto: parts[2] }, fecha: new Date().toISOString().split('T')[0] });
        ejecutadas.push({ accion, detalle: parts[2] });
      } else if (accion === 'meta') {
        await supabase.from('metas').insert({ user_id: userId, titulo: parts[1], tipo: parts[2] || 'personal', monto_objetivo: parseFloat(parts[3]) || null, fecha_limite: parts[4] || null, año: new Date().getFullYear() });
        ejecutadas.push({ accion, detalle: parts[1] });
      }
      // 'memoria' ya se maneja en extraerYGuardarMemorias
    } catch (e) { console.error('Error acción:', accion, e.message); }
  }
  return ejecutadas;
}
