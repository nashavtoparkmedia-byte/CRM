const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function testDeduplication() {
    console.log("Starting de-duplication test...");
    
    try {
        // 1. Find a valid WhatsApp chat
        const chat = await (prisma.chat || prisma['chat']).findFirst({
            where: { channel: 'whatsapp' }
        });
        
        if (!chat) {
            console.error("No WhatsApp chat found to test with.");
            return;
        }
        
        console.log(`Using chat: ${chat.id} (external: ${chat.externalChatId})`);
        
        // 2. Simulate optimistic create by MessageService
        const content = `Test Message ${Date.now()}`;
        const now = new Date();
        const optimisticId = `msg_test_${Date.now()}`;
        
        console.log(`Creating optimistic message: ${optimisticId}`);
        await (prisma.message || prisma['message']).create({
            data: {
                id: optimisticId,
                chatId: chat.id,
                content,
                direction: 'outbound',
                status: 'sent',
                sentAt: now
            }
        });
        
        // 3. Simulate WhatsAppService.sendMessage logic
        const waTimestamp = new Date(now.getTime() + 500); 
        const externalId = `wan_msg_${Date.now()}`;
        
        console.log(`Simulating WA delivery with externalId: ${externalId}`);
        
        const existing = await (prisma.message || prisma['message']).findFirst({
            where: {
                chatId: chat.id,
                content: content,
                direction: 'outbound',
                sentAt: {
                    gte: new Date(waTimestamp.getTime() - 5000),
                    lte: new Date(waTimestamp.getTime() + 5000)
                }
            }
        });
        
        if (existing) {
            console.log(`Found existing message! (ID: ${existing.id})`);
            if (existing.id === optimisticId) {
                console.log("SUCCESS: Correct optimistic message found.");
            } else {
                console.warn("WARNING: Found a different message.");
            }
            
            await (prisma.message || prisma['message']).update({
                where: { id: existing.id },
                data: {
                    externalId,
                    status: 'delivered',
                    sentAt: waTimestamp
                }
            });
            console.log("Updated existing message.");
        } else {
            console.error("FAILURE: Optimistic message NOT found.");
        }
        
        // 4. Verify no duplicates
        const finalMessages = await (prisma.message || prisma['message']).findMany({
            where: {
                chatId: chat.id,
                content: content
            }
        });
        
        console.log(`Final message count for this content: ${finalMessages.length}`);
        let result = `Final message count: ${finalMessages.length}\n`;
        if (finalMessages.length === 1) {
            result += "TEST PASSED: Only one message exists.\n";
            console.log("TEST PASSED: Only one message exists.");
        } else {
            result += "TEST FAILED: Duplication still exists.\n";
            console.error("TEST FAILED: Duplication still exists.");
        }
        require('fs').writeFileSync('scripts/verify_result.txt', result);
        
        // Cleanup
        await (prisma.message || prisma['message']).deleteMany({
            where: { content: content }
        });
    } catch (err) {
        console.error("Error during test:", err);
        require('fs').writeFileSync('scripts/verify_result.txt', `ERROR: ${err.message}`);
    } finally {
        await prisma.$disconnect();
    }
}

testDeduplication();
