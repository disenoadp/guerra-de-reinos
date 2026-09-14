const express = require('express');
const neo4j = require('neo4j-driver');
const app = express();
const PORT = process.env.PORT || 3000;

const driver = neo4j.driver(
    process.env.NEO4J_URI,
    neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
);

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

function toNum(val) {
    if (val === null || val === undefined) return 0;
    return typeof val === 'number' ? val : val.toNumber();
}

async function actualizarRecursos(session, nombreJugador) {
    const ahora = Date.now();
    await session.run(`
        MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(t:Territorio)
        SET t.hierro = toInteger(t.hierro + (toFloat($ahora - t.ultima_visita)/1000.0) * (t.nivel_mina_hierro * 1000.0 / 3600.0)),
            t.madera = toInteger(t.madera + (toFloat($ahora - t.ultima_visita)/1000.0) * (t.nivel_aserradero * 800.0 / 3600.0)),
            t.alimento = toInteger(t.alimento + (toFloat($ahora - t.ultima_visita)/1000.0) * (t.nivel_granja * 600.0 / 3600.0)),
            t.ultima_visita = $ahora
    `, { nombre: nombreJugador, ahora: ahora });
}

async function resolverBatallas(session, nombreJugador) {
    const ahora = Date.now();
    const result = await session.run(`
        MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(origen:Territorio)
        WHERE origen.ataque_fin IS NOT NULL AND origen.ataque_fin <= $ahora
        RETURN origen.nombre AS origen, origen.ataque_destino AS destino, origen.ataque_tropas AS tropas
    `, { nombre: nombreJugador, ahora: ahora });

    for (const record of result.records) {
        const origenNom = record.get('origen');
        const destinoNom = record.get('destino');
        const tropas = toNum(record.get('tropas'));
        await session.run(`
            MATCH (origen:Territorio {nombre: $origenNom}), (destino:Territorio {nombre: $destinoNom})
            SET origen.hierro = toInteger(origen.hierro + destino.hierro * 0.5),
                origen.madera = toInteger(origen.madera + destino.madera * 0.5),
                destino.hierro = toInteger(destino.hierro * 0.5),
                destino.madera = toInteger(destino.madera * 0.5),
                origen.tropas_hostigador = toInteger(origen.tropas_hostigador + $tropas),
                origen.ataque_fin = null, origen.ataque_destino = null, origen.ataque_tropas = 0
        `, { origenNom, destinoNom, tropas });
    }
}

// --- RUTAS DE LOGIN Y MAPA ---
app.get('/', (req, res) => res.render('login', { error: null, success: null }));

app.post('/entrar', async (req, res) => {
    const nombre = req.body.usuario;
    const session = driver.session();
    try {
        const result = await session.run(`MATCH (j:Jugador {nombre: $nombre}) RETURN j`, { nombre });
        if (result.records.length > 0) res.redirect(`/panel/${nombre}`);
        else res.render('login', { error: 'Ese rey no existe.', success: null });
    } catch (e) { res.status(500).send('Error'); } finally { await session.close(); }
});

app.post('/crear-rey', async (req, res) => {
    const nombre = req.body.usuario;
    const session = driver.session();
    try {
        const check = await session.run(`MATCH (j:Jugador {nombre: $nombre}) RETURN j`, { nombre });
        if (check.records.length > 0) return res.render('login', { error: 'Nombre en uso.', success: null });
        
        const result = await session.run(`MATCH (t:Territorio {ocupado: false}) RETURN t.nombre AS nombre ORDER BY rand() LIMIT 1`);
        if (result.records.length === 0) return res.render('login', { error: 'Continente lleno.', success: null });
        
        const territorioNombre = result.records[0].get('nombre');
        await session.run(`
            MATCH (t:Territorio {nombre: $nombre})
            CREATE (j:Jugador {nombre: $jugador}) CREATE (j)-[:POSEE]->(t)
            SET t.ocupado = true, t.hierro = 500, t.madera = 500, t.oro = 200, t.alimento = 200,
                t.nivel_mina_hierro = 0, t.nivel_aserradero = 0, t.nivel_granja = 0, t.nivel_cuartel = 0,
                t.tropas_hostigador = 0, t.construccion_tipo = null, t.construccion_fin = null,
                t.entrenando_tipo = null, t.entrenando_fin = null,
                t.ataque_destino = null, t.ataque_fin = null, t.ataque_tropas = 0, t.ultima_visita = $ahora
        `, { nombre: territorioNombre, jugador: nombre, ahora: Date.now() });
        res.redirect(`/panel/${nombre}`);
    } catch (e) { res.status(500).send('Error'); } finally { await session.close(); }
});

app.get('/generar-mapa', async (req, res) => {
    const session = driver.session();
    try {
        await session.run('MATCH (n) DETACH DELETE n');
        await session.run(`UNWIND range(1, 3) AS region UNWIND range(1, 3) AS provincia UNWIND range(1, 3) AS territorio MERGE (t:Territorio {nombre: 'R'+region+'-P'+provincia+'-T'+territorio, ocupado: false, region: region, provincia: provincia})`);
        await session.run(`MATCH (t1:Territorio), (t2:Territorio) WHERE t1.region = t2.region AND t1.provincia = t2.provincia AND t1.nombre <> t2.nombre MERGE (t1)-[:FRONTERA]->(t2) MERGE (t2)-[:FRONTERA]->(t1)`);
        await session.run(`MATCH (t1:Territorio), (t2:Territorio) WHERE t1.region = t2.region AND t1.provincia <> t2.provincia AND abs(t1.provincia - t2.provincia) = 1 MERGE (t1)-[:FRONTERA]->(t2) MERGE (t2)-[:FRONTERA]->(t1)`);
        res.render('login', { error: null, success: 'Mapa generado. 27 territorios creados.' });
    } catch (error) { res.status(500).send('Error'); } finally { await session.close(); }
});

// --- RUTAS DEL JUEGO ---
app.get('/panel/:nombre', async (req, res) => {
    const nombreJugador = req.params.nombre;
    const session = driver.session();
    try {
        const ahora = Date.now();
        await resolverBatallas(session, nombreJugador);
        await session.run(`MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(t:Territorio) WHERE t.construccion_fin IS NOT NULL AND t.construccion_fin <= $ahora SET t.nivel_mina_hierro = CASE WHEN t.construccion_tipo = 'mina-hierro' THEN t.nivel_mina_hierro + 1 ELSE t.nivel_mina_hierro END, t.nivel_aserradero = CASE WHEN t.construccion_tipo = 'aserradero' THEN t.nivel_aserradero + 1 ELSE t.nivel_aserradero END, t.nivel_granja = CASE WHEN t.construccion_tipo = 'granja' THEN t.nivel_granja + 1 ELSE t.nivel_granja END, t.nivel_cuartel = CASE WHEN t.construccion_tipo = 'cuartel' THEN t.nivel_cuartel + 1 ELSE t.nivel_cuartel END, t.construccion_fin = null, t.construccion_tipo = null`, { nombre: nombreJugador, ahora });
        await session.run(`MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(t:Territorio) WHERE t.entrenando_fin IS NOT NULL AND t.entrenando_fin <= $ahora SET t.tropas_hostigador = t.tropas_hostigador + 1, t.entrenando_fin = null, t.entrenando_tipo = null`, { nombre: nombreJugador, ahora });
        await actualizarRecursos(session, nombreJugador);
        
        const result = await session.run(`MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(t:Territorio) RETURN t.nombre AS territorio, t.hierro AS hierro, t.madera AS madera, t.oro AS oro, t.alimento AS alimento, t.nivel_mina_hierro AS mina, t.nivel_aserradero AS aserradero, t.nivel_granja AS granja, t.nivel_cuartel AS cuartel, t.tropas_hostigador AS tropas, t.construccion_fin AS fin_c, t.construccion_tipo AS tipo_c, t.entrenando_fin AS fin_e, t.ataque_fin AS fin_a, t.ataque_destino AS destino_a`, { nombre: nombreJugador });
        
        if (result.records.length === 0) return res.send('Jugador no encontrado.');
        const d = result.records[0];
        
        res.render('dashboard', {
            jugador: nombreJugador, territorio: d.get('territorio'),
            hierro: toNum(d.get('hierro')), madera: toNum(d.get('madera')), oro: toNum(d.get('oro')), alimento: toNum(d.get('alimento')),
            mina: toNum(d.get('mina')), aserradero: toNum(d.get('aserradero')), granja: toNum(d.get('granja')), cuartel: toNum(d.get('cuartel')),
            tropas: toNum(d.get('tropas')),
            construccionFin: d.get('fin_c') ? toNum(d.get('fin_c')) : null, tipoConstruccion: d.get('tipo_c'),
            entrenandoFin: d.get('fin_e'), ataqueFin: d.get('fin_a'), ataqueDestino: d.get('destino_a')
        });
    } catch (e) { console.error(e); res.status(500).send('Error'); } finally { await session.close(); }
});

app.get('/construir/:nombre/:edificio', async (req, res) => {
    const { nombre: nombreJugador, edificio } = req.params;
    const session = driver.session();
    const niveles = { 'mina-hierro': 'nivel_mina_hierro', 'aserradero': 'nivel_aserradero', 'granja': 'nivel_granja', 'cuartel': 'nivel_cuartel' };
    try {
        await actualizarRecursos(session, nombreJugador);
        const result = await session.run(`MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(t:Territorio) RETURN t.${niveles[edificio]} AS nivel, t.hierro AS hierro, t.madera AS madera, t.construccion_fin AS fin`, { nombre: nombreJugador });
        if (result.records.length === 0) return res.status(404).json({ error: 'No encontrado' });
        const d = result.records[0];
        if (d.get('fin') !== null) return res.status(400).json({ error: 'Ya hay construcción en curso.' });
        const costeH = Math.floor(100 * Math.pow(1.5, toNum(d.get('nivel'))));
        const costeM = Math.floor(50 * Math.pow(1.5, toNum(d.get('nivel'))));
        if (toNum(d.get('hierro')) < costeH || toNum(d.get('madera')) < costeM) return res.status(400).json({ error: 'Sin recursos.' });
        const tiempoFin = Date.now() + (30 + (toNum(d.get('nivel')) * 30) * 1000);
        await session.run(`MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(t:Territorio) SET t.hierro = toInteger(t.hierro - $cH), t.madera = toInteger(t.madera - $cM), t.construccion_tipo = $e, t.construccion_fin = $t`, { nombre: nombreJugador, cH: costeH, cM: costeM, e: edificio, t: tiempoFin });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Error interno' }); } finally { await session.close(); }
});

app.get('/entrenar/:nombre/:tropa', async (req, res) => {
    const { nombre: nombreJugador, tropa } = req.params;
    const session = driver.session();
    try {
        await actualizarRecursos(session, nombreJugador);
        const result = await session.run(`MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(t:Territorio) RETURN t.nivel_cuartel AS cuartel, t.hierro AS hierro, t.madera AS madera, t.oro AS oro, t.entrenando_fin AS fin`, { nombre: nombreJugador });
        if (result.records.length === 0) return res.status(404).json({ error: 'No encontrado' });
        const d = result.records[0];
        if (toNum(d.get('cuartel')) === 0) return res.status(400).json({ error: 'Sin cuartel.' });
        if (d.get('fin') !== null) return res.status(400).json({ error: 'Ya entrenando.' });
        if (toNum(d.get('hierro')) < 50 || toNum(d.get('madera')) < 20 || toNum(d.get('oro')) < 10) return res.status(400).json({ error: 'Sin recursos.' });
        const tiempoFin = Date.now() + 15000;
        await session.run(`MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(t:Territorio) SET t.hierro = toInteger(t.hierro - 50), t.madera = toInteger(t.madera - 20), t.oro = toInteger(t.oro - 10), t.entrenando_tipo = $tr, t.entrenando_fin = $t`, { nombre: nombreJugador, tr: tropa, t: tiempoFin });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Error' }); } finally { await session.close(); }
});

// (Las rutas de /atacar, /guerra y /chat se mantienen funcionalmente igual, las adaptaremos visualmente en el siguiente paso si lo deseas)
app.get('/atacar/:nombre/:destino', async (req, res) => {
    const { nombre: nombreJugador, destino } = req.params;
    const session = driver.session();
    try {
        await actualizarRecursos(session, nombreJugador);
        const result = await session.run(`MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(origen:Territorio), (destino:Territorio {nombre: $destino}) RETURN origen.nombre AS o, origen.tropas_hostigador AS t, origen.ataque_fin AS fin, shortestPath((origen)-[:FRONTERA*]-(destino)) AS p`, { nombre: nombreJugador, destino });
        if (result.records.length === 0) return res.status(400).json({ error: 'Destino no encontrado.' });
        const d = result.records[0];
        if (d.get('o') === destino) return res.status(400).json({ error: 'No a tu propio reino.' });
        if (d.get('fin') !== null) return res.status(400).json({ error: 'Ya en marcha.' });
        if (toNum(d.get('t')) === 0) return res.status(400).json({ error: 'Sin tropas.' });
        const distancia = d.get('p') ? d.get('p').length : 1;
        const tiempoFin = Date.now() + (distancia * 30 * 1000);
        await session.run(`MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(t:Territorio) SET t.tropas_hostigador = toInteger(t.tropas_hostigador - $t), t.ataque_destino = $d, t.ataque_fin = $f, t.ataque_tropas = $t`, { nombre: nombreJugador, d: destino, f: tiempoFin, t: toNum(d.get('t')) });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Error' }); } finally { await session.close(); }
});

app.get('/guerra/:nombre', async (req, res) => {
    const nombreJugador = req.params.nombre;
    const session = driver.session();
    try {
        const result = await session.run(`MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(origen:Territorio), (destino:Territorio) WHERE origen <> destino OPTIONAL MATCH (defensor:Jugador)-[:POSEE]->(destino) RETURN destino.nombre AS n, defensor.nombre AS d, length(shortestPath((origen)-[:FRONTERA*]-(destino))) AS dist`, { nombre: nombreJugador });
        let html = `<link rel="stylesheet" href="/css/style.css"><div class="container"><h2 class="section-title">Sala de Guerra</h2><div class="card"><table style="width:100%; text-align:left;"><tr><th>Territorio</th><th>Dueño</th><th>Distancia</th><th>Acción</th></tr>`;
        result.records.forEach(r => {
            const dist = toNum(r.get('dist'));
            html += `<tr><td>${r.get('n')}</td><td>${r.get('d') || 'Vacío'}</td><td>${dist} saltos</td><td><a href="/atacar/${nombreJugador}/${r.get('n')}" class="btn btn-red" onclick="return confirm('Atacar?')">Atacar</a></td></tr>`;
        });
        html += `</table></div><br><a href="/panel/${nombreJugador}" class="btn">Volver</a></div>`;
        res.send(html);
    } catch (e) { res.status(500).send('Error'); } finally { await session.close(); }
});

app.get('/chat/:nombre', async (req, res) => {
    const nombreJugador = req.params.nombre;
    const session = driver.session();
    try {
        const result = await session.run(`MATCH (m:Mensaje) RETURN m.autor AS a, m.texto AS t ORDER BY m.tiempo DESC LIMIT 20`);
        let html = `<link rel="stylesheet" href="/css/style.css"><div class="container"><h2 class="section-title">Tablón</h2><div class="card" style="height:400px; overflow-y:auto;">`;
        result.records.reverse().forEach(r => { html += `<p><b>${r.get('a')}:</b> ${r.get('t')}</p>`; });
        html += `</div><form action="/enviar-mensaje" method="POST" style="display:flex; gap:10px; margin-top:10px;"><input type="hidden" name="autor" value="${nombreJugador}"><input type="text" name="texto" class="form-control" style="flex-grow:1; padding:10px;" required><button class="btn">Enviar</button></form><br><a href="/panel/${nombreJugador}" class="btn">Volver</a></div>`;
        res.send(html);
    } catch (e) { res.status(500).send('Error'); } finally { await session.close(); }
});

app.post('/enviar-mensaje', async (req, res) => {
    const { autor, texto } = req.body;
    const session = driver.session();
    try { await session.run(`CREATE (m:Mensaje {autor: $a, texto: $t, tiempo: $ti})`, { a: autor, t: texto, ti: Date.now() }); res.redirect(`/chat/${autor}`); } finally { await session.close(); }
});

app.listen(PORT, () => console.log(`Servidor corriendo en ${PORT}`));
