const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { maxBrowser, logToFile } = require('./maxBrowser');

const app = express();
const PORT = process.env.PORT || 3005;

app.use(cors());
app.use(express.json());

// Эндпоинт для отправки сообщения
app.post('/send-message', async (req, res) => {
    const { phone, message, name } = req.body;
    logToFile(`[API] Получен запрос на отправку: phone=${phone}, name="${name || ''}"`);
    
    if (!phone || !message) {
        return res.status(400).json({ error: 'phone and message are required' });
    }

    try {
        await maxBrowser.sendMessage(phone, message, name);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        isLoggedIn: maxBrowser.isLoggedIn,
        browserInitialized: !!maxBrowser.context
    });
});

// Эндпоинт статуса (авторизован или нет)
app.get('/status', (req, res) => {
    const qrExists = fs.existsSync(path.join(__dirname, 'last_qr.png'));
    res.json({ 
        isLoggedIn: maxBrowser.isLoggedIn,
        qrGenerated: qrExists
    });
});

// Эндпоинт для получения любого отладочного скриншота
app.get('/debug-image/:name', (req, res) => {
    const imageName = req.params.name;
    const imagePath = path.join(__dirname, imageName.endsWith('.png') ? imageName : `${imageName}.png`);
    res.sendFile(imagePath, (err) => {
        if (err) {
            res.status(404).json({ error: 'Image not found' });
        }
    });
});

// Эндпоинт для получения QR кода
app.get('/qr', (req, res) => {
    const qrPath = path.join(__dirname, 'last_qr.png');
    res.sendFile(qrPath, (err) => {
        if (err) {
            res.status(404).json({ error: 'QR code not found or not generated yet' });
        }
    });
});

// Эндпоинт для перезапуска (генерации нового QR)
app.post('/restart', async (req, res) => {
    try {
        await maxBrowser.restart();
        res.json({ success: true, message: 'Browser restarting to generate new QR' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    logToFile(`Сервис MAX Web Scraper запущен на порту ${PORT}`);
    logToFile('Начало инициализации браузера в фоновом режиме...');
    
    // Запускаем инициализацию без await, чтобы сервер сразу начал отвечать на /status
    maxBrowser.init().then(() => {
        logToFile('Инициализация браузера завершена успешно.');
    }).catch(error => {
        logToFile('ОШИБКА при первичной инициализации: ' + error.message);
    });
});
