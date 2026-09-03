const express = require('express');
const neo4j = require('neo4j-driver');
const app = express();
const PORT = process.env.PORT || 3000;

const driver = neo4j.driver(
    process.env.NEO4J_URI,
    neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
);

// CONFIGURACIÓN VISUAL
app.set('view engine', 'ejs'); // Usamos EJS para las pantallas
app.use(express.urlencoded({ extended: true })); // Para leer formularios
app.use(express.json()); 
app.use(express.static('public')); // Carpeta para nuestros CSS e imágenes

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
                origen.ataque_fin = null,
                origen.ataque_destino = null,
                origen.ataque_tropas = 0
        `, { origenNom, destinoNom, tropas });
    }
}

// Ruta principal: muestra el Login
app.get('/', (req, res) => {
    res.render('login', { error: null });
});

// Ruta para procesar el login
app.post('/entrar', async (req, res) => {
    const nombre = req.body.usuario;
    const session = driver.session();
    try {
        const result = await session.run(`MATCH (j:Jugador {nombre: $nombre}) RETURN j`, { nombre: nombre });
        if (result.records.length > 0) {
            // Si el jugador existe, lo mandamos a su panel
            res.redirect(`/panel/${nombre}`);
        } else {
            // Si no existe, devolvemos error al login
            res.render('login', { error: 'Ese rey no existe en el continente.' });
        }
    } catch (error) {
        res.status(500).send('Error al entrar.');
    } finally {
        await session.close();
    }
});

app.get('/mapa', async (req, res) => {
    const session = driver.session();
    try {
        const result = await session.run(`MATCH (t:Territorio) OPTIONAL MATCH (j:Jugador)-[:POSEE]->(t) RETURN t.nombre AS nombre, j.nombre AS jugador`);
        const territorios = result.records.map(record => {
            const nombre = record.get('nombre');
            const jugador = record.get('jugador');
            return jugador ? `${nombre} (Ocupado por ${jugador})` : `${nombre} (Vacio)`;
        });
        if (territorios.length === 0) res.send('<h1>Mapa de Aethel</h1><p>El mapa esta vacio. Visita /generar-mapa.</p>');
        else res.send(`<h1>Mapa de Aethel</h1><ul>${territorios.map(t => `<li>${t}</li>`).join('')}</ul>`);
    } catch (error) { console.error(error); res.status(500).send('Error.'); } finally { await session.close(); }
});

app.get('/generar-mapa', async (req, res) => {
    const session = driver.session();
    try {
        // Borramos todo y creamos el mapa en una sola consulta segura
        await session.run(`
            MATCH (n) DETACH DELETE n
            CREATE (t1:Territorio {nombre: 'Territorio 1', ocupado: false}),
                   (t2:Territorio {nombre: 'Territorio 2', ocupado: false}),
                   (t3:Territorio {nombre: 'Territorio 3', ocupado: false}),
                   (t4:Territorio {nombre: 'Territorio 4', ocupado: false}),
                   (t5:Territorio {nombre: 'Territorio 5', ocupado: false})
            CREATE (t1)-[:FRONTERA]->(t2), (t2)-[:FRONTERA]->(t1),
                   (t2)-[:FRONTERA]->(t3), (t3)-[:FRONTERA]->(t2),
                   (t3)-[:FRONTERA]->(t4), (t4)-[:FRONTERA]->(t3),
                   (t4)-[:FRONTERA]->(t5), (t5)-[:FRONTERA]->(t4)
        `);
        res.send('Mapa generado con exito.');
    } catch (error) {
        console.error("ERROR GENERANDO MAPA:", error);
        res.status(500).send('Error al generar mapa. Revisa los logs de Render.');
    } finally {
        await session.close();
    }
});

app.get('/registrar/:nombre', async (req, res) => {
    const nombreJugador = req.params.nombre;
    const session = driver.session();
    try {
        // Protección contra duplicados
        const checkJugador = await session.run(`MATCH (j:Jugador {nombre: $nombre}) RETURN j`, { nombre: nombreJugador });
        if (checkJugador.records.length > 0) return res.send('Ese nombre de jugador ya existe. Elige otro.');

        const result = await session.run(`MATCH (t:Territorio {ocupado: false}) RETURN t.nombre AS nombre ORDER BY rand() LIMIT 1`);
        if (result.records.length === 0) return res.send('No hay territorios vacios.');
        const territorioNombre = result.records[0].get('nombre');
        
        await session.run(`
            MATCH (t:Territorio {nombre: $nombre})
            CREATE (j:Jugador {nombre: $jugador})
            CREATE (j)-[:POSEE]->(t)
            SET t.ocupado = true, 
                t.hierro = 500, t.madera = 500, t.oro = 200, t.alimento = 200,
                t.nivel_mina_hierro = 0, t.nivel_aserradero = 0, t.nivel_granja = 0, t.nivel_cuartel = 0,
                t.tropas_hostigador = 0,
                t.construccion_tipo = null, t.construccion_fin = null,
                t.entrenando_tipo = null, t.entrenando_fin = null,
                t.ataque_destino = null, t.ataque_fin = null, t.ataque_tropas = 0,
                t.ultima_visita = $ahora
        `, { nombre: territorioNombre, jugador: nombreJugador, ahora: Date.now() });
        res.send(`<h1>Bienvenido, ${nombreJugador}</h1><p>Visita /panel/${nombreJugador}</p>`);
    } catch (error) { console.error(error); res.status(500).send('Error al registrar.'); } finally { await session.close(); }
});

app.get('/construir/:nombre/:edificio', async (req, res) => {
    const nombreJugador = req.params.nombre;
    const edificio = req.params.edificio;
    const session = driver.session();
    const niveles = { 'mina-hierro': 'nivel_mina_hierro', 'aserradero': 'nivel_aserradero', 'granja': 'nivel_granja', 'cuartel': 'nivel_cuartel' };
    const nivelKey = niveles[edificio];
    if (!nivelKey) return res.status(400).json({ error: 'Edificio no valido.' });
    try {
        await actualizarRecursos(session, nombreJugador);
        const result = await session.run(`
            MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(t:Territorio)
            RETURN t.nivel_mina_hierro AS nivel_mina_hierro, t.nivel_aserradero AS nivel_aserradero, 
                   t.nivel_granja AS nivel_granja, t.nivel_cuartel AS nivel_cuartel,
                   t.hierro AS hierro, t.madera AS madera, t.construccion_fin AS fin
        `, { nombre: nombreJugador });
        if (result.records.length === 0) return res.status(404).json({ error: 'Jugador no encontrado.' });
        const data = result.records[0];
        const nivelActual = toNum(data.get(nivelKey));
        const hierroActual = toNum(data.get('hierro'));
        const maderaActual = toNum(data.get('madera'));
        const construccionFin = data.get('fin'); 
        if (construccionFin !== null) return res.status(400).json({ error: 'Ya hay un edificio en construccion.' });
        const costeHierro = Math.floor(100 * Math.pow(1.5, nivelActual));
        const costeMadera = Math.floor(50 * Math.pow(1.5, nivelActual));
        if (hierroActual < costeHierro || maderaActual < costeMadera) return res.status(400).json({ error: `Recursos insuficientes.` });
        const tiempoConstruccionMs = (30 + (nivelActual * 30)) * 1000; 
        const tiempoFin = Date.now() + tiempoConstruccionMs;
        await session.run(`
            MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(t:Territorio)
            SET t.hierro = toInteger(t.hierro - $costeH), t.madera = toInteger(t.madera - $costeM), 
                t.construccion_tipo = $edificio, t.construccion_fin = $tiempoFin
        `, { nombre: nombreJugador, costeH: costeHierro, costeM: costeMadera, tiempoFin: tiempoFin, edificio: edificio });
        res.json({ success: true });
    } catch (error) { console.error(error); res.status(500).json({ error: 'Error interno.' }); } finally { await session.close(); }
});

app.get('/entrenar/:nombre/:tropa', async (req, res) => {
    const nombreJugador = req.params.nombre;
    const tropa = req.params.tropa;
    const session = driver.session();
    if (tropa !== 'hostigador') return res.status(400).json({ error: 'Tropa no valida.' });
    try {
        await actualizarRecursos(session, nombreJugador);
        const result = await session.run(`
            MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(t:Territorio)
            RETURN t.nivel_cuartel AS nivel_cuartel, t.hierro AS hierro, t.madera AS madera, t.oro AS oro, t.entrenando_fin AS fin
        `, { nombre: nombreJugador });
        if (result.records.length === 0) return res.status(404).json({ error: 'Jugador no encontrado.' });
        const data = result.records[0];
        const nivelCuartel = toNum(data.get('nivel_cuartel'));
        if (nivelCuartel === 0) return res.status(400).json({ error: 'Necesitas un Cuartel primero.' });
        const hierroActual = toNum(data.get('hierro'));
        const maderaActual = toNum(data.get('madera'));
        const oroActual = toNum(data.get('oro'));
        const entrenandoFin = data.get('fin');
        if (entrenandoFin !== null) return res.status(400).json({ error: 'Ya hay tropas entrenandose.' });
        const costeHierro = 50, costeMadera = 20, costeOro = 10;
        if (hierroActual < costeHierro || maderaActual < costeMadera || oroActual < costeOro) return res.status(400).json({ error: 'Recursos insuficientes.' });
        const tiempoEntrenamientoMs = 15000; 
        const tiempoFin = Date.now() + tiempoEntrenamientoMs;
        await session.run(`
            MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(t:Territorio)
            SET t.hierro = toInteger(t.hierro - $costeH), t.madera = toInteger(t.madera - $costeM),
                t.oro = toInteger(t.oro - $costeOro), t.entrenando_tipo = $tropa, t.entrenando_fin = $tiempoFin
        `, { nombre: nombreJugador, costeH: costeHierro, costeM: costeMadera, costeOro: costeOro, tiempoFin: tiempoFin, tropa: tropa });
        res.json({ success: true });
    } catch (error) { console.error(error); res.status(500).json({ error: 'Error interno.' }); } finally { await session.close(); }
});

app.get('/atacar/:nombre/:destino', async (req, res) => {
    const nombreJugador = req.params.nombre;
    const destino = req.params.destino;
    const session = driver.session();
    try {
        await actualizarRecursos(session, nombreJugador);
        const result = await session.run(`
            MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(origen:Territorio), (destino:Territorio {nombre: $destino})
            RETURN origen.nombre AS origen_nom, origen.tropas_hostigador AS tropas, origen.ataque_fin AS fin,
                   shortestPath((origen)-[:FRONTERA*]-(destino)) AS path
        `, { nombre: nombreJugador, destino: destino });
        if (result.records.length === 0) return res.status(400).json({ error: 'Territorio destino no encontrado.' });
        const data = result.records[0];
        const origenNom = data.get('origen_nom');
        const tropas = toNum(data.get('tropas'));
        const atacandoFin = data.get('fin');
        const path = data.get('path');
        if (origenNom === destino) return res.status(400).json({ error: 'No puedes atacar tu propio territorio.' });
        if (atacandoFin !== null) return res.status(400).json({ error: 'Ya tienes tropas en marcha.' });
        if (tropas === 0) return res.status(400).json({ error: 'No tienes tropas para enviar.' });
        const distancia = path ? path.length : 1; 
        const tiempoViajeMs = (distancia * 30) * 1000; 
        const tiempoFin = Date.now() + tiempoViajeMs;
        await session.run(`
            MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(t:Territorio)
            SET t.tropas_hostigador = toInteger(t.tropas_hostigador - $tropas),
                t.ataque_destino = $destino, t.ataque_fin = $tiempoFin, t.ataque_tropas = $tropas
        `, { nombre: nombreJugador, destino: destino, tiempoFin: tiempoFin, tropas: tropas });
        res.json({ success: true, distancia: distancia });
    } catch (error) { console.error(error); res.status(500).json({ error: 'Error interno.' }); } finally { await session.close(); }
});

function generarHtmlEdificio(nombreJugador, edificio, nivelActual, estaConstruyendo, tipoConstruccion, construccionFin, ahora) {
    const nombres = { 'mina-hierro': 'Mina de Hierro', 'aserradero': 'Aserradero', 'granja': 'Granja', 'cuartel': 'Cuartel' };
    const produccion = { 'mina-hierro': nivelActual * 1000, 'aserradero': nivelActual * 800, 'granja': nivelActual * 600, 'cuartel': '-' };
    const costeHierro = Math.floor(100 * Math.pow(1.5, nivelActual));
    const costeMadera = Math.floor(50 * Math.pow(1.5, nivelActual));
    if (estaConstruyendo && tipoConstruccion === edificio) {
        const tiempoRestante = Math.max(0, Math.floor((construccionFin - ahora) / 1000));
        return `<div class="edificio"><b>${nombres[edificio]} (Nivel ${nivelActual})</b> - Prod: ${produccion[edificio]}/h<br><small>Construyendo... Tiempo restante: <span id="timer-${edificio}">${tiempoRestante}</span>s</small><div id="timer-msg-${edificio}" style="margin-top: 10px;"></div></div><script>let t=document.getElementById('timer-${edificio}').innerText;setInterval(()=>{t--;if(t<=0){document.getElementById('timer-msg-${edificio}').innerHTML='<b style=\"color:lightgreen;\">Finalizada!</b> <a href=\"/panel/${nombreJugador}\">Actualizar</a>';document.getElementById('timer-${edificio}').style.display='none';}else{document.getElementById('timer-${edificio}').innerText=t;}},1000);</script>`;
    } else if (estaConstruyendo) {
        return `<div class="edificio"><b>${nombres[edificio]} (Nivel ${nivelActual})</b> - Prod: ${produccion[edificio]}/h<br><small>Esperando a que termine la otra construccion...</small></div>`;
    } else {
        return `<div class="edificio"><b>${nombres[edificio]} (Nivel ${nivelActual})</b> - Prod: ${produccion[edificio]}/h<br><small>Coste: ${costeHierro} Hierro, ${costeMadera} Madera</small><button onclick="mejorar('${edificio}')" class="btn">Mejorar</button><div id="msg-${edificio}" style="color: red; margin-top: 10px;"></div></div><script>async function mejorar(e){const r=await fetch('/construir/${nombreJugador}/'+e);const d=await r.json();if(d.success){location.reload();}else{document.getElementById('msg-'+e).innerText=d.error;}}</script>`;
    }
}

app.get('/panel/:nombre', async (req, res) => {
    const nombreJugador = req.params.nombre;
    const session = driver.session();
    try {
        const ahora = Date.now();
        await resolverBatallas(session, nombreJugador);
        await session.run(`MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(t:Territorio) WHERE t.construccion_fin IS NOT NULL AND t.construccion_fin <= $ahora SET t.nivel_mina_hierro = CASE WHEN t.construccion_tipo = 'mina-hierro' THEN t.nivel_mina_hierro + 1 ELSE t.nivel_mina_hierro END, t.nivel_aserradero = CASE WHEN t.construccion_tipo = 'aserradero' THEN t.nivel_aserradero + 1 ELSE t.nivel_aserradero END, t.nivel_granja = CASE WHEN t.construccion_tipo = 'granja' THEN t.nivel_granja + 1 ELSE t.nivel_granja END, t.nivel_cuartel = CASE WHEN t.construccion_tipo = 'cuartel' THEN t.nivel_cuartel + 1 ELSE t.nivel_cuartel END, t.construccion_fin = null, t.construccion_tipo = null`, { nombre: nombreJugador, ahora: ahora });
        await session.run(`MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(t:Territorio) WHERE t.entrenando_fin IS NOT NULL AND t.entrenando_fin <= $ahora SET t.tropas_hostigador = t.tropas_hostigador + 1, t.entrenando_fin = null, t.entrenando_tipo = null`, { nombre: nombreJugador, ahora: ahora });
        await actualizarRecursos(session, nombreJugador);
        const result = await session.run(`MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(t:Territorio) RETURN t.nombre AS territorio, t.hierro AS hierro, t.madera AS madera, t.oro AS oro, t.alimento AS alimento, t.nivel_mina_hierro AS nivel_mina, t.nivel_aserradero AS nivel_aserradero, t.nivel_granja AS nivel_granja, t.nivel_cuartel AS nivel_cuartel, t.tropas_hostigador AS tropas, t.construccion_fin AS fin_c, t.construccion_tipo AS tipo_c, t.entrenando_fin AS fin_e, t.ataque_fin AS fin_a, t.ataque_destino AS destino_a`, { nombre: nombreJugador });
        if (result.records.length === 0) return res.send('Jugador no encontrado.');
        const data = result.records[0];
        const hierro = toNum(data.get('hierro')); const madera = toNum(data.get('madera')); const oro = toNum(data.get('oro')); const alimento = toNum(data.get('alimento'));
        const nivelMina = toNum(data.get('nivel_mina')); const nivelAserradero = toNum(data.get('nivel_aserradero')); const nivelGranja = toNum(data.get('nivel_granja')); const nivelCuartel = toNum(data.get('nivel_cuartel'));
        const tropas = toNum(data.get('tropas'));
        const construccionFin = data.get('fin_c') ? toNum(data.get('fin_c')) : null; const tipoConstruccion = data.get('tipo_c'); const entrenandoFin = data.get('fin_e') ? toNum(data.get('fin_e')) : null;
        const ataqueFin = data.get('fin_a') ? toNum(data.get('fin_a')) : null; const ataqueDestino = data.get('destino_a');

        const htmlMina = generarHtmlEdificio(nombreJugador, 'mina-hierro', nivelMina, construccionFin !== null, tipoConstruccion, construccionFin, ahora);
        const htmlAserradero = generarHtmlEdificio(nombreJugador, 'aserradero', nivelAserradero, construccionFin !== null, tipoConstruccion, construccionFin, ahora);
        const htmlGranja = generarHtmlEdificio(nombreJugador, 'granja', nivelGranja, construccionFin !== null, tipoConstruccion, construccionFin, ahora);
        const htmlCuartel = generarHtmlEdificio(nombreJugador, 'cuartel', nivelCuartel, construccionFin !== null, tipoConstruccion, construccionFin, ahora);

        let htmlTropas = "";
        if (nivelCuartel > 0) {
            if (entrenandoFin) {
                const tiempoRestante = Math.max(0, Math.floor((entrenandoFin - ahora) / 1000));
                htmlTropas = `<div class="edificio"><b>Entrenando Hostigador...</b><br><small>Tiempo: <span id="timer-tropa">${tiempoRestante}</span>s</small><div id="timer-msg-tropa" style="margin-top: 10px;"></div></div><script>let tT=document.getElementById('timer-tropa').innerText;setInterval(()=>{tT--;if(tT<=0){document.getElementById('timer-msg-tropa').innerHTML='<b style=\"color:lightgreen;\">Lista!</b> <a href=\"/panel/${nombreJugador}\">Actualizar</a>';document.getElementById('timer-tropa').style.display='none';}else{document.getElementById('timer-tropa').innerText=tT;}},1000);</script>`;
            } else {
                htmlTropas = `<div class="edificio"><b>Hostigadores</b> (Tienes: ${tropas})<br><small>Coste: 50 Hierro, 20 Madera, 10 Oro</small><button onclick="entrenar('hostigador')" class="btn">Entrenar 1</button><div id="msg-tropa" style="color: red; margin-top: 10px;"></div></div><script>async function entrenar(t){const r=await fetch('/entrenar/${nombreJugador}/'+t);const d=await r.json();if(d.success){location.reload();}else{document.getElementById('msg-tropa').innerText=d.error;}}</script>`;
            }
        } else { htmlTropas = `<div class="edificio"><b>Tropas</b><br><small>Construye un Cuartel.</small></div>`; }

        let htmlAtaque = "";
        if (ataqueFin) {
            const tiempoRestante = Math.max(0, Math.floor((ataqueFin - ahora) / 1000));
            htmlAtaque = `<div class="edificio"><b>Tropas en Marcha!</b><br><small>Objetivo: ${ataqueDestino}. Vuelven en: <span id="timer-ataque">${tiempoRestante}</span>s</small><div id="timer-msg-ataque" style="margin-top: 10px;"></div></div><script>let tA=document.getElementById('timer-ataque').innerText;setInterval(()=>{tA--;if(tA<=0){document.getElementById('timer-msg-ataque').innerHTML='<b style=\"color:lightgreen;\">Tropas de vuelta!</b> <a href=\"/panel/${nombreJugador}\">Actualizar</a>';document.getElementById('timer-ataque').style.display='none';}else{document.getElementById('timer-ataque').innerText=tA;}},1000);</script>`;
        } else if (tropas > 0) {
            htmlAtaque = `<div class="edificio"><b>Sala de Guerra</b><br><small>Tienes ${tropas} tropas listas para la batalla.</small><a href="/guerra/${nombreJugador}" class="btn" style="text-decoration:none; display:inline-block; text-align:center;">Ir a la Guerra</a></div>`;
        } else {
            htmlAtaque = `<div class="edificio"><b>Sala de Guerra</b><br><small>Necesitas tropas para ir a la guerra.</small></div>`;
        }

        res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><style>body{font-family:Georgia,serif;background-color:#2c3e50;color:white;text-align:center;}.panel{background-color:#34495e;width:80%;margin:auto;padding:20px;border-radius:10px;margin-top:50px;}.recursos{display:flex;justify-content:space-around;margin-top:20px;margin-bottom:40px;}.recurso{background:#2c3e50;padding:15px;border-radius:8px;width:20%;}.titulo{color:#f39c12;}.edificio{background:#2c3e50;padding:15px;border-radius:8px;margin-top:10px;text-align:left;}.btn{background:#e67e22;color:white;padding:10px 20px;border:none;border-radius:5px;float:right;cursor:pointer;}.btn:hover{background:#d35400;}</style></head><body><div class="panel"><h1 class="titulo">Panel del Reino</h1><h2>${nombreJugador}</h2><p>Territorio: <b>${data.get('territorio')}</b></p><div class="recursos"><div class="recurso"><h3>Hierro</h3><p>${hierro}</p></div><div class="recurso"><h3>Madera</h3><p>${madera}</p></div><div class="recurso"><h3>Oro</h3><p>${oro}</p></div><div class="recurso"><h3>Alimento</h3><p>${alimento}</p></div></div><h3>Edificios</h3>${htmlMina}${htmlAserradero}${htmlGranja}${htmlCuartel}<h3>Ejercito</h3>${htmlTropas}${htmlAtaque}</div></body></html>`);
    } catch (error) { console.error(error); res.status(500).send('Error.'); } finally { await session.close(); }
});

app.get('/guerra/:nombre', async (req, res) => {
    const nombreJugador = req.params.nombre;
    const session = driver.session();
    try {
        const result = await session.run(`
            MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(origen:Territorio), (destino:Territorio)
            WHERE origen <> destino
            OPTIONAL MATCH (defensor:Jugador)-[:POSEE]->(destino)
            RETURN destino.nombre AS nombre, defensor.nombre AS duenio, 
                   length(shortestPath((origen)-[:FRONTERA*]-(destino))) AS distancia
        `, { nombre: nombreJugador });

        let filasTabla = result.records.map(record => {
            const nombre = record.get('nombre');
            const duenio = record.get('duenio') || 'Vacío';
            const distancia = toNum(record.get('distancia'));
            const tiempo = distancia * 30;
            return `<tr><td>${nombre}</td><td>${duenio}</td><td>${distancia}</td><td>${tiempo}s</td><td><a href="/atacar/${nombreJugador}/${nombre}" class="btn-atacar">Atacar</a></td></tr>`;
        }).join('');

        res.send(`
            <!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><style>body{font-family:Georgia,serif;background-color:#2c3e50;color:white;text-align:center;}.panel{background-color:#34495e;width:80%;margin:auto;padding:20px;border-radius:10px;margin-top:50px;}table{width:100%;border-collapse:collapse;margin-top:20px;}th,td{border:1px solid #2c3e50;padding:10px;}th{background:#2c3e50;}.btn-atacar{background:#c0392b;color:white;padding:8px 15px;text-decoration:none;border-radius:5px;}.titulo{color:#f39c12;}a.volver{color:#f39c12;float:left;text-decoration:none;}</style></head><body>
            <div class="panel">
                <a href="/panel/${nombreJugador}" class="volver"><- Volver al Panel</a>
                <h1 class="titulo">Sala de Guerra</h1>
                <h3>Objetivos Disponibles</h3>
                <table>
                    <tr><th>Territorio</th><th>Dueño</th><th>Distancia</th><th>Tiempo de Viaje</th><th>Acción</th></tr>
                    ${filasTabla}
                </table>
            </div></body></html>
        `);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al cargar la sala de guerra.');
    } finally {
        await session.close();
    }
});

app.listen(PORT, () => { console.log(`El Reino esta corriendo en el puerto ${PORT}`); });
