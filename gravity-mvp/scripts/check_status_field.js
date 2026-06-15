const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  const conn = await prisma.apiConnection.findFirst({ where: { name: 'Yoko' } });
  const res = await fetch('https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list', {
    method: 'POST',
    headers: { 'X-Client-ID': conn.clid, 'X-Api-Key': conn.apiKey, 'Accept-Language': 'ru', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: { park: { id: conn.parkId }, text: '79920934377' },
      fields: { driver_profile: ['id', 'first_name', 'last_name', 'phones', 'work_status'], car: [], account: [], current_status: ['status'] },
      limit: 10, offset: 0
    })
  });
  const data = await res.json();
  for (const p of data.driver_profiles || []) {
    console.log(JSON.stringify({
      id: p.driver_profile.id,
      name: `${p.driver_profile.first_name} ${p.driver_profile.last_name}`,
      work_status: p.driver_profile.work_status,
      current_status: p.current_status?.status,
      phones: p.driver_profile.phones,
    }, null, 2));
  }
  await prisma.$disconnect();
}
run().catch(console.error);
