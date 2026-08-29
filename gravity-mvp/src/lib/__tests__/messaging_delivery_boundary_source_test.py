from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def test_messaging_delivery_runtime_has_no_provider_sdk_or_internal_provider_imports():
    targets = {
        "lib/MessageService.ts": [
            "./whatsapp/WhatsAppService",
            "@/app/settings/integrations/whatsapp/whatsapp-actions",
            "@/app/max-actions",
            "@/app/tg-actions",
        ],
        "lib/pipeline/ChannelAdapterRegistry.ts": [
            "@/app/max-actions",
            "@/app/tg-actions",
            "@/lib/whatsapp/WhatsAppService",
        ],
        "app/api/messages/reaction/route.ts": [
            "@/lib/whatsapp/WhatsAppService",
            "@/app/tg-actions",
            "import('telegram')",
        ],
        "app/api/messages/send-media/route.ts": [
            "@/lib/whatsapp/WhatsAppService",
            "@/app/tg-actions",
            "MAX_SCRAPER_URL",
        ],
    }
    for relative, forbidden in targets.items():
        source = read(relative)
        assert "channel-delivery-runtime" in source
        for marker in forbidden:
            assert marker not in source, f"{relative} still reaches provider transport through {marker}"


def test_provider_capabilities_are_registered_only_at_platform_startup():
    instrumentation = read("instrumentation.ts")
    assert "registerWhatsAppMessagingDeliveryCapabilityV1" in instrumentation
    assert "registerTelegramMessagingDeliveryCapabilityV1" in instrumentation
    assert "registerMaxMessagingDeliveryCapabilityV1" in instrumentation
    assert "channel_delivery_capabilities_registered" in instrumentation
    assert instrumentation.index("registerWhatsAppMessagingDeliveryCapabilityV1") < instrumentation.index("setTimeout(async () =>")


if __name__ == "__main__":
    test_messaging_delivery_runtime_has_no_provider_sdk_or_internal_provider_imports()
    test_provider_capabilities_are_registered_only_at_platform_startup()
    print("messaging_delivery_boundary_source_test.py: PASS")
