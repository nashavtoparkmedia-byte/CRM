const http = require('http');
// Check status with contacts count
http.get('http://localhost:3005/status', res => {
  let d = ''; res.on('data', c => d += c);
  res.on('end', () => console.log('Status:', d));
});
