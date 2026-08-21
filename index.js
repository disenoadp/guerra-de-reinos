const express = require('express');
const neo4j = require('neo4j-driver');
const app = express();
const PORT = process.env.PORT || 3000;

const driver = neo4j.driver(
    process.env.NEO4J_URI,
    neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
);

app.get('/', (req, res) => {
    res.send('<h1>Guerra de Reinos</h1><p>El servidor del continente esta activo.</p>');
});

// Ruta para ver el mapa y quien lo posee
app.get('/mapa', async (req, res) => {
    const session = driver.session();
    try {
        const result = await session.run(`
            MATCH (t:Territorio)
            OPTIONAL MATCH (j:Jugador)-[:POSEE]->(t)
            RETURN t.nombre AS nombre, j.nombre AS jugador
        `);
        
        const territorios = result.records.map(record => {
            const nombre = record.get('nombre');
            const jugador = record.get('jugador');
            return jugador ? `${nombre} (Ocupado por ${jugador})` : `${nombre} (Vacio)`;
        });

        if (territorios.length === 0) {
            res.send('<h1>Mapa de Aethel</h1><p>El mapa esta vacio. Visita /generar-mapa para crear territorios.</p>');
        } else {
            res.send(`<h1>Mapa de Aethel</h1><ul>${territorios.map(t => `<li>${t}</li>`).join('')}</ul>`);
        }
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al conectar con la base de datos.');
    } finally {
        await session.close();
    }
});

// Ruta para generar el mapa de prueba
app.get('/generar-mapa', async (req, res) => {
    const session = driver.session();
    try {
        await session.run('MATCH (n) DETACH DELETE n');
        for (let i = 1; i <= 5; i++) {
            await session.run('CREATE (t:Territorio {id: $id, nombre: $nombre, ocupado: false})', { 
                id: i, 
                nombre: `Territorio ${i}` 
            });
        }
        for (let i = 1; i < 5; i++) {
            await session.run(`
                MATCH (a:Territorio {id: $a}), (b:Territorio {id: $b})
                CREATE (a)-[:FRONTERA]->(b)
                CREATE (b)-[:FRONTERA]->(a)
            `, { a: i, b: i + 1 });
        }
        res.send('Mapa generado con exito. Se crearon 5 territorios conectados.');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al generar el mapa.');
    } finally {
        await session.close();
    }
});

// Ruta de Registro con Asignacion Aleatoria y Recursos Iniciales
app.get('/registrar/:nombre', async (req, res) => {
    const nombreJugador = req.params.nombre;
    const session = driver.session();
    try {
        const result = await session.run(`
            MATCH (t:Territorio {ocupado: false}) 
            RETURN t.nombre AS nombre 
            ORDER BY rand() 
            LIMIT 1
        `);
        
        if (result.records.length === 0) {
            return res.send('No hay territorios vacios para colonizar.');
        }

        const territorioNombre = result.records[0].get('nombre');

        // Asignamos el territorio al jugador y le damos recursos iniciales
        await session.run(`
            MATCH (t:Territorio {nombre: $nombre})
            CREATE (j:Jugador {nombre: $jugador})
            CREATE (j)-[:POSEE]->(t)
            SET t.ocupado = true, 
                t.hierro = 500, 
                t.madera = 500, 
                t.oro = 200, 
                t.alimento = 200
        `, { nombre: territorioNombre, jugador: nombreJugador });

        res.send(`<h1>Bienvenido, ${nombreJugador}</h1><p>Has reclamado el ${territorioNombre}. Tu imperio comienza. Visita /panel/${nombreJugador} para ver tus recursos.</p>`);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al registrar jugador.');
    } finally {
        await session.close();
    }
});

// NUEVA RUTA: Panel de Control del Jugador
app.get('/panel/:nombre', async (req, res) => {
    const nombreJugador = req.params.nombre;
    const session = driver.session();
    try {
        // Buscamos al jugador y los datos de su territorio
        const result = await session.run(`
            MATCH (j:Jugador {nombre: $nombre})-[:POSEE]->(t:Territorio)
            RETURN t.nombre AS territorio, t.hierro AS hierro, t.madera AS madera, t.oro AS oro, t.alimento AS alimento
        `, { nombre: nombreJugador });

        if (result.records.length === 0) {
            return res.send('Jugador no encontrado. Asegurate de registrarte primero.');
        }

        const data = result.records[0];
        
        // Generamos una pagina web HTML sencilla para el panel
        res.send(`
            <!DOCTYPE html>
            <html lang="es">
            <head>
                <meta charset="UTF-8">
                <style>
                    body { font-family: Georgia, serif; background-color: #2c3e50; color: white; text-align: center; }
                    .panel { background-color: #34495e; width: 80%; margin: auto; padding: 20px; border-radius: 10px; margin-top: 50px; }
                    .recursos { display: flex; justify-content: space-around; margin-top: 20px; }
                    .recurso { background: #2c3e50; padding: 15px; border-radius: 8px; width: 20%; }
                    .titulo { color: #f39c12; }
                </style>
            </head>
            <body>
                <div class="panel">
                    <h1 class="titulo">Panel del Reino</h1>
                    <h2>${nombreJugador}</h2>
                    <p>Territorio Actual: <b>${data.get('territorio')}</b></p>
                    
                    <div class="recursos">
                        <div class="recurso"><h3>Hierro</h3><p>${data.get('hierro')}</p></div>
                        <div class="recurso"><h3>Madera</h3><p>${data.get('madera')}</p></div>
                        <div class="recurso"><h3>Oro</h3><p>${data.get('oro')}</p></div>
                        <div class="recurso"><h3>Alimento</h3><p>${data.get('alimento')}</p></div>
                    </div>
                </div>
            </body>
            </html>
        `);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al cargar el panel.');
    } finally {
        await session.close();
    }
});

app.listen(PORT, () => {
    console.log(`El Reino esta corriendo en el puerto ${PORT}`);
});
