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

// Ruta para ver el mapa y quién lo posee
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
            return jugador ? `${nombre} (Ocupado por ${jugador})` : `${nombre} (Vacío)`;
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

// Ruta de Registro con Asignación Aleatoria
app.get('/registrar/:nombre', async (req, res) => {
    const nombreJugador = req.params.nombre;
    const session = driver.session();
    try {
        // 1. Buscamos un territorio vacío de forma aleatoria usando 'rand()'
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

        // 2. Creamos al jugador y le asignamos el territorio aleatorio
        await session.run(`
            MATCH (t:Territorio {nombre: $nombre})
            CREATE (j:Jugador {nombre: $jugador})
            CREATE (j)-[:POSEE]->(t)
            SET t.ocupado = true
        `, { nombre: territorioNombre, jugador: nombreJugador });

        res.send(`<h1>Bienvenido, ${nombreJugador}</h1><p>Has reclamado el ${territorioNombre} de forma aleatoria. Tu imperio comienza.</p>`);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al registrar jugador.');
    } finally {
        await session.close();
    }
});

app.listen(PORT, () => {
    console.log(`El Reino esta corriendo en el puerto ${PORT}`);
});
