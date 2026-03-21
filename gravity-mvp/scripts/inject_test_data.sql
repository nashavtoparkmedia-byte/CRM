DO $$
DECLARE
    v_driver_id TEXT;
BEGIN
    SELECT id INTO v_driver_id FROM "Driver" LIMIT 1;
    
    IF v_driver_id IS NOT NULL THEN
        -- Insert or Update Chat
        INSERT INTO "Chat" (id, "driverId", channel, "externalChatId", name, "lastMessageAt", "unreadCount", "requiresResponse", status, "createdAt", "updatedAt")
        VALUES ('test_chat_1', v_driver_id, 'whatsapp', 'wa_test_123', 'Иван Петров', NOW(), 2, true, 'active', NOW(), NOW())
        ON CONFLICT ("externalChatId") DO UPDATE SET 
            "unreadCount" = 2, 
            "requiresResponse" = true, 
            status = 'active', 
            "lastMessageAt" = NOW();

        -- Insert Message
        INSERT INTO "Message" (id, "chatId", direction, type, content, status, "sentAt", "createdAt", "updatedAt")
        VALUES ('test_msg_1', 'test_chat_1', 'inbound', 'text', 'Перезвоните позже, пожалуйста.', 'delivered', NOW(), NOW(), NOW())
        ON CONFLICT (id) DO NOTHING;
    END IF;
END $$;
