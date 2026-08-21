const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Ruta principal para probar que el servidor funciona
app.get('/', (req, res) => {
    res.send('<h1>Guerra de Reinos</h1><p>El servidor del continente esta activo.</p>');
});

// Mantenemos el servidor escuchando
app.listen(PORT, () => {
    console.log(`El Reino esta corriendo en el puerto ${PORT}`);
});
