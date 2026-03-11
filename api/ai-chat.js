// /api/ai-chat.js — Claude con memoria profunda y registros visibles
const supabase = require('../lib/supabase');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { message, history = [], imagen_base64, user_id } = req.body;
  if (!message && !imagen_base64) return res.status(400).json({ error: 'Mensaje requerido' });
  if (!user_id) return res.status(400).json({ error: 'user_id requerido' });

  try {
    // 1. Cargar contexto financiero completo
    const contexto = await buildContexto(user_id);

    // 2. Cargar memoria del usuario
    const { data: memorias } = await supabase
      .from('ai_memory')
      .select('contenido, tipo, importancia')
      .eq('user_id', user_id)
      .order('importancia', { ascending: false })
      .limit(50);

    // 3. Cargar resúmenes de sesiones anteriores
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
    const respuestaLimpia = respuesta
      .replace(/\[ACCION:[^\]]+\]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // 5. Ejecutar acciones — registros visibles en la app
    const acciones = await ejecutarAcciones(respuesta, contexto, user_id);

    // 6. Guardar memoria de esta conversación
    await guardarMemoria(message, respuesta, user_id);

    // 7. Guardar resumen de sesión SIEMPRE (no solo cada 6 mensajes)
    if (history.length >= 2) {
      await guardarResumenSesion(history, message, respuesta, user_id);
    }

    return res.json({ ok: true, respuesta: respuestaLimpia, acciones });
  } catch (error) {
    console.error('AI chat error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// ═══ CONTEXTO FINANCIERO COMPLETO ═══
async function buildContexto(userId) {
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
    supabase.from('accounts').select('*').eq('user_id', userId),
    supabase.from('movements').select('*').eq('user_id', userId)
      .gte('fecha', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0])
      .order('fecha', { ascending: false }).limit(50),
    supabase.from('movements').select('*').eq('user_id', userId)
      .order('created_at', { ascending: false }).limit(5),
    supabase.from('payments').select('*').eq('user_id', userId).neq('status', 'pagado'),
    supabase.from('events').select('*').eq('user_id', userId)
      .gte('fecha', new Date().toISOString().split('T')[0]).order('fecha').limit(10),
    supabase.from('cajas').select('*').eq('user_id', userId),
    supabase.from('metas').select('*, micrometas(*)').eq('user_id', userId).eq('estado', 'activa'),
    supabase.from('reminders').select('*').eq('user_id', userId).limit(5)
  ]);

  const totalSaldo = (cuentas || []).reduce((a, c) => a + parseFloat(c.saldo || 0), 0);
  const totalCajas = (cajas || []).reduce((a, c) => a + parseFloat(c.saldo || 0), 0);
  const ingresosMes = (movsMes || []).filter(m => m.tipo === 'ingreso').reduce((a, m) => a + parseFloat(m.monto), 0);
  const gastosMes = (movsMes || []).filter(m => m.tipo === 'gasto').reduce((a, m) => a + parseFloat(m.monto), 0);

  return {
    totalSaldo, totalCajas, ingresosMes, gastosMes,
    cuentas: cuentas || [], movimientos: movsMes || [],
    movsRecientes: movsRecientes || [], pagos: pagos || [],
    eventos: eventos || [], cajas: cajas || [],
    metas: metas || [], recordatorios: recordatorios || []
  };
}

// ═══ FORMATEAR MEMORIA ═══
function formatearMemoria(memorias, sesiones) {
  const porTipo = {};
  for (const m of memorias) {
    if (!porTipo[m.tipo]) porTipo[m.tipo] = [];
    porTipo[m.tipo].push(m.contenido);
  }

  let txt = '';
  if (porTipo.perfil?.length)      txt += `PERFIL: ${porTipo.perfil.join(' | ')}\n`;
  if (porTipo.negocio?.length)     txt += `NEGOCIOS: ${porTipo.negocio.join(' | ')}\n`;
  if (porTipo.objetivo?.length)    txt += `OBJETIVOS: ${porTipo.objetivo.join(' | ')}\n`;
  if (porTipo.habito?.length)      txt += `HÁBITOS: ${porTipo.habito.join(' | ')}\n`;
  if (porTipo.preferencia?.length) txt += `PREFERENCIAS: ${porTipo.preferencia.join(' | ')}\n`;
  if (porTipo.patron?.length)      txt += `PATRONES: ${porTipo.patron.join(' | ')}\n`;
  if (porTipo.dato?.length)        txt += `DATOS: ${porTipo.dato.join(' | ')}\n`;
  if (porTipo.general?.length)     txt += `OTROS: ${porTipo.general.join(' | ')}\n`;

  if (sesiones.length > 0) {
    txt += `\nCONVERSACIONES ANTERIORES:\n`;
    for (const s of sesiones) {
      const fecha = new Date(s.created_at).toLocaleDateString('es-CO');
      txt += `• [${fecha}] ${s.resumen}\n`;
    }
  }

  return txt || 'Primera conversación con este usuario — aprender todo lo posible.';
}

// ═══ SYSTEM PROMPT ═══
function buildSystemPrompt(ctx, memoria) {
  const fmt = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(n);
  const hoy = new Date().toLocaleDateString('es-CO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  return `Eres Ana, agente financiero personal. Tienes MEMORIA COMPLETA y acceso TOTAL a las finanzas del usuario en tiempo real.

HOY: ${hoy}

═══ LO QUE SABES DE ESTE USUARIO ═══
${memoria}

═══ ESTADO FINANCIERO ACTUAL ═══
Total bancos: ${fmt(ctx.totalSaldo)}
Total efectivo: ${fmt(ctx.totalCajas)}
TOTAL: ${fmt(ctx.totalSaldo + ctx.totalCajas)}

Cuentas: ${ctx.cuentas.map(c => `${c.nombre}(${fmt(c.saldo)})[ID:${c.id}]`).join(' | ') || 'ninguna'}
Cajas: ${ctx.cajas.map(c => `${c.nombre}(${fmt(c.saldo)})[ID:${c.id}]`).join(' | ') || 'ninguna'}

Mes actual — Ingresos: ${fmt(ctx.ingresosMes)} | Gastos: ${fmt(ctx.gastosMes)} | Balance: ${fmt(ctx.ingresosMes - ctx.gastosMes)}

Últimos movimientos:
${ctx.movsRecientes.map(m => `• ${m.tipo==='ingreso'?'↑':'↓'} ${fmt(m.monto)} — ${m.descripcion} (${m.fecha}) [ID:${m.id}]`).join('\n') || 'ninguno'}

Todos los movimientos del mes:
${ctx.movimientos.map(m => `• ${m.tipo==='ingreso'?'+':'-'}${fmt(m.monto)} ${m.descripcion} ${m.fecha} [ID:${m.id}]`).join('\n') || 'ninguno'}

Pagos pendientes:
${ctx.pagos.map(p => `• ${p.nombre}: ${fmt(p.monto)} vence ${p.fecha_limite} [ID:${p.id}]`).join('\n') || 'ninguno'}

Próximos eventos:
${ctx.eventos.map(e => `• ${e.titulo} — ${e.fecha} ${e.hora||''} [ID:${e.id}]`).join('\n') || 'ninguno'}

Metas activas:
${ctx.metas.map(m => `• ${m.titulo} — ${m.progreso||0}% — ${(m.micrometas||[]).filter(mm=>mm.completada).length}/${(m.micrometas||[]).length} pasos [ID:${m.id}]`).join('\n') || 'ninguna'}

═══ ACCIONES — INVISIBLES AL USUARIO ═══
Ponlas AL FINAL de tu respuesta. El usuario NUNCA las ve.
Cada vez que el usuario mencione algo importante DEBES guardarlo en memoria.

REGISTRAR (aparece visible en la app):
[ACCION:gasto|monto|descripcion|categoria]
[ACCION:ingreso|monto|descripcion|categoria]
[ACCION:pago|nombre|monto|YYYY-MM-DD]
[ACCION:evento|titulo|YYYY-MM-DD|HH:MM]
[ACCION:recordatorio|texto]
[ACCION:meta|titulo|tipo|monto_objetivo|YYYY-MM-DD]

BORRAR:
[ACCION:borrar_movimiento|ID]
[ACCION:borrar_pago|ID]
[ACCION:borrar_evento|ID]

MEMORIA (persiste entre sesiones):
[ACCION:memoria|tipo|contenido|importancia]
  tipos: perfil, negocio, objetivo, habito, preferencia, patron, dato

═══ REGLAS CRÍTICAS ═══
1. NUNCA muestres [ACCION:...] en tu respuesta — son invisibles
2. Cuando alguien diga "gasté X en Y" → usa [ACCION:gasto|X|Y|categoria]
3. Cuando alguien diga "me llegaron X" → usa [ACCION:ingreso|X|descripcion|ingreso]
4. TODO lo que registres aparece visible en la app — confirma: "✅ Registré $X en Y"
5. Si el insert falla lo sabrás porque no habrá confirmación del servidor
6. GUARDA EN MEMORIA todo dato personal: nombre, negocios, metas, hábitos, ciudad
7. Si el usuario menciona su nombre → [ACCION:memoria|perfil|Se llama X|5]
8. Si menciona negocios → [ACCION:memoria|negocio|descripcion|4]
9. Si menciona objetivos → [ACCION:memoria|objetivo|descripcion|4]
10. Respuestas CORTAS y directas — máximo 3 líneas salvo análisis
11. Español colombiano, tono cálido
12. Si te preguntan qué recuerdas → cuéntale TODO lo que tienes guardado`;
}

// ═══ LLAMAR A CLAUDE ═══
async function llamarClaude(system, history, message, imagen) {
  const userContent = [];
  if (imagen) userContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imagen } });
  userContent.push({ type: 'text', text: message || 'Analiza esta imagen' });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
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
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content[0].text;
}

// ═══ EJECUTAR ACCIONES — TODO QUEDA VISIBLE EN LA APP ═══
async function ejecutarAcciones(respuesta, contexto, userId) {
  const matches = [...respuesta.matchAll(/\[ACCION:([^\]]+)\]/g)];
  const ejecutadas = [];

  for (const match of matches) {
    const parts = match[1].split('|');
    const accion = parts[0].trim();

    try {
      if (accion === 'gasto' || accion === 'ingreso') {
        const monto = parseFloat(parts[1]);
        const desc = (parts[2] || 'Sin descripción').trim();
        const cat = (parts[3] || 'otro').trim();

        if (!monto || monto <= 0) continue;

        // Usar primera cuenta si existe, sino null
        const cuentaId = contexto.cuentas[0]?.id || null;

        // Insertar movimiento — verificar resultado
        const { data: mov, error: movError } = await supabase
          .from('movements')
          .insert({
            user_id: userId,
            tipo: accion,
            descripcion: desc,
            monto,
            fecha: new Date().toISOString().split('T')[0],
            account_id: cuentaId,
            categoria: cat,
            source: 'ia'
          })
          .select()
          .single();

        if (movError) {
          console.error('Error insertando movimiento:', movError);
          continue;
        }

        // Actualizar saldo de la cuenta
        if (cuentaId && contexto.cuentas[0]) {
          const saldoActual = parseFloat(contexto.cuentas[0].saldo || 0);
          const nuevoSaldo = accion === 'ingreso' ? saldoActual + monto : saldoActual - monto;
          await supabase.from('accounts').update({ saldo: nuevoSaldo }).eq('id', cuentaId).eq('user_id', userId);
        }

        ejecutadas.push({ accion, monto, desc, id: mov.id });

      } else if (accion === 'borrar_movimiento') {
        const { error } = await supabase.from('movements').delete().eq('id', parts[1]).eq('user_id', userId);
        if (!error) ejecutadas.push({ accion: 'borrado', tipo: 'movimiento' });

      } else if (accion === 'borrar_pago') {
        const { error } = await supabase.from('payments').delete().eq('id', parts[1]).eq('user_id', userId);
        if (!error) ejecutadas.push({ accion: 'borrado', tipo: 'pago' });

      } else if (accion === 'borrar_evento') {
        const { error } = await supabase.from('events').delete().eq('id', parts[1]).eq('user_id', userId);
        if (!error) ejecutadas.push({ accion: 'borrado', tipo: 'evento' });

      } else if (accion === 'pago') {
        const { error } = await supabase.from('payments').insert({
          user_id: userId,
          nombre: parts[1],
          monto: parseFloat(parts[2]),
          fecha_limite: parts[3],
          status: 'pendiente'
        });
        if (!error) ejecutadas.push({ accion, detalle: parts[1] });

      } else if (accion === 'evento') {
        const { error } = await supabase.from('events').insert({
          user_id: userId,
          titulo: parts[1],
          fecha: parts[2],
          hora: parts[3] || null,
          nota: 'Creado por IA'
        });
        if (!error) ejecutadas.push({ accion, detalle: parts[1] });

      } else if (accion === 'recordatorio') {
        const { error } = await supabase.from('reminders').insert({
          user_id: userId,
          tipo: 'nota',
          titulo: parts[1],
          content: { texto: parts[1] },
          fecha: new Date().toISOString().split('T')[0]
        });
        if (!error) ejecutadas.push({ accion, detalle: parts[1] });

      } else if (accion === 'meta') {
        const { error } = await supabase.from('metas').insert({
          user_id: userId,
          titulo: parts[1],
          tipo: parts[2] || 'personal',
          monto_objetivo: parseFloat(parts[3]) || null,
          fecha_limite: parts[4] || null,
          año: new Date().getFullYear(),
          estado: 'activa',
          progreso: 0
        });
        if (!error) ejecutadas.push({ accion, detalle: parts[1] });
      }
      // memoria se maneja en guardarMemoria()

    } catch (e) {
      console.error('Error ejecutando acción:', accion, e.message);
    }
  }

  return ejecutadas;
}

// ═══ GUARDAR MEMORIA — Claude decide qué es importante ═══
async function guardarMemoria(mensaje, respuesta, userId) {
  // Extraer [ACCION:memoria|tipo|contenido|importancia] de la respuesta
  const matches = [...respuesta.matchAll(/\[ACCION:memoria\|([^|]+)\|([^|]+)\|?(\d?)\]/g)];

  for (const m of matches) {
    const tipo = m[1].trim();
    const contenido = m[2].trim();
    const importancia = parseInt(m[3]) || 3;

    if (!contenido || contenido.length < 3) continue;

    // Buscar si ya existe algo similar para no duplicar
    const { data: existente } = await supabase
      .from('ai_memory')
      .select('id')
      .eq('user_id', userId)
      .eq('tipo', tipo)
      .ilike('contenido', `%${contenido.substring(0, 20)}%`)
      .maybeSingle();

    if (existente) {
      await supabase.from('ai_memory')
        .update({ contenido, importancia })
        .eq('id', existente.id);
    } else {
      await supabase.from('ai_memory').insert({
        user_id: userId,
        tipo,
        contenido,
        importancia
      });
    }
  }
}

// ═══ GUARDAR RESUMEN DE SESIÓN — siempre al final ═══
async function guardarResumenSesion(history, ultimoMensaje, ultimaRespuesta, userId) {
  try {
    const ultimos = history.slice(-4).map(h =>
      `${h.role === 'user' ? 'Usuario' : 'Ana'}: ${typeof h.content === 'string' ? h.content : h.content?.[0]?.text || ''}`
    ).join('\n');

    const conversacion = `${ultimos}\nUsuario: ${ultimoMensaje}\nAna: ${ultimaRespuesta.substring(0, 300)}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 120,
        messages: [{
          role: 'user',
          content: `Resume en 1 línea lo más importante de esta conversación financiera (qué se habló, qué se registró, qué se acordó):\n${conversacion}`
        }]
      })
    });

    const data = await response.json();
    const resumen = data.content?.[0]?.text?.trim();

    if (resumen) {
      await supabase.from('ia_sesiones').insert({
        user_id: userId,
        resumen,
        mensajes_count: history.length + 1
      });
    }
  } catch (e) {
    // Silencioso — no bloquear la respuesta principal
  }
}
