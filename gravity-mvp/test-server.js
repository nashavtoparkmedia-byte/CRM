const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Select Test</title>
<style>
  body { font-family: -apple-system, sans-serif; padding: 40px; background: #f5f5f5; }
  .card { max-width: 500px; margin: 0 auto; background: white; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
  .sync { margin-top: 12px; border-radius: 12px; border: 1px solid #E8E8E8; background: #FAFAFA; padding: 16px; }
  .days-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; margin-left: 20px; }
  select { height: 36px; border-radius: 8px; border: 1px solid #D0D0D0; font-size: 14px; font-weight: 500; padding: 0 12px; background: white; cursor: pointer; }
  select:focus { outline: none; border-color: #3390EC; }
  .result { margin-top: 12px; padding: 10px; background: #f0f9ff; border-radius: 8px; font-size: 13px; color: #1a73e8; }
  button { height: 32px; padding: 0 16px; border-radius: 8px; background: #3390EC; color: white; font-size: 12px; font-weight: 600; border: none; cursor: pointer; margin-top: 12px; }
</style></head>
<body>
<div class="card">
  <h3>ChannelSyncBlock — select дней</h3>
  <div class="sync">
    <label style="display:flex;gap:8px;cursor:pointer;font-size:12px">
      <input type="radio" name="m" checked>
      <span>За последние N дней</span>
    </label>
    <div class="days-row">
      <select id="days">
        <option value="7">7</option>
        <option value="14">14</option>
        <option value="30" selected>30</option>
        <option value="60">60</option>
        <option value="90">90</option>
        <option value="180">180</option>
        <option value="365">365</option>
      </select>
      <span style="font-size:13px;color:#888">дней</span>
    </div>
    <button id="btn">Запустить</button>
  </div>
  <div class="result" id="r">Выберите дни и нажмите Запустить</div>
</div>
<script>
document.getElementById('days').onchange = function() {
  document.getElementById('r').textContent = 'Выбрано: ' + this.value + ' дней';
};
document.getElementById('btn').onclick = function() {
  document.getElementById('r').textContent = 'Синхронизация: дней=' + document.getElementById('days').value;
};
</script>
</body></html>`);
});
server.listen(3333, () => console.log('http://localhost:3333'));
