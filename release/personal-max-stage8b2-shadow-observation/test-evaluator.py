#!/usr/bin/env python3
from copy import deepcopy
import json
from pathlib import Path

import jsonschema

from evaluate import (
    EXACT_MIGRATION_SAFETY,
    EXACT_PRIVACY,
    EXACT_SAFETY,
    EXPECTED_BACKUP_REPORT_SHA,
    EXPECTED_COMPOSE_IDENTITY,
    EXPECTED_DORMANT_COMPOSE_SHA,
    EXPECTED_DORMANT_ROLLBACK_SHA,
    EXPECTED_DORMANT_SCRIPT_SHA,
    EXPECTED_DORMANT_NETWORK,
    EXPECTED_GATEWAY_REF,
    EXPECTED_LEDGER_ONLY,
    EXPECTED_MIGRATIONS,
    EXPECTED_MIGRATION_SCRIPT_SHA,
    EXPECTED_PROJECTION_FILES,
    EXPECTED_SCRAPER_REF,
    EXPECTED_SOURCE_COMMIT,
    ROLLBACK_RESERVE_BYTES,
    evaluate,
    validate_final_report,
)


def account(alias_character='a', rows=0, comparisons=0):
    return {
        'alias': alias_character * 64,
        'rawJournalRows': rows,
        'rawJournalRowsPerSecond': round(rows / 300, 6),
        'accidentalDuplicateEnvelopes': 0,
        'rawQuarantined': 0,
        'normalizationResults': rows,
        'normalizationQuarantined': 0,
        'normalizationUnsupported': 0,
        'semanticComparisons': comparisons,
        'semanticRegressions': 0,
        'criticalRegressions': 0,
        'criticalDiffs': 0,
        'routeIdentityCritical': 0,
        'openRouteConflicts': 0,
        'unprocessedRows': 0,
        'oldestUnprocessedSeconds': 0,
        'journalLatencyMs': {'p50': 1, 'p95': 2, 'p99': 3},
    }


def image(reference):
    return {
        'acceptedRef': reference,
        'configuredRef': reference,
        'imageId': 'sha256:' + 'c' * 64,
        'repoDigests': [reference],
        'acceptedDigestPresent': True,
    }


def migration_binding():
    return {
        'sha256': '9' * 64,
        'evidence': {
            'schemaVersion': 1,
            'mode': 'PRODUCTION_MIGRATION_EVIDENCE',
            'script': {'sha256': EXPECTED_MIGRATION_SCRIPT_SHA, 'checksumBound': True},
            'bindings': {'isolatedReportSha256': '8' * 64, 'acceptedBackupReportSha256': EXPECTED_BACKUP_REPORT_SHA},
            'databaseBinding': {
                'source': 'postgres-container-env',
                'projectLabel': 'crm',
                'serviceLabel': 'postgres',
                'envKeys': ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB'],
                'urlHost': 'postgres',
                'urlPort': 5432,
                'urlSchema': 'public',
                'inspectMode': '0600',
                'envMode': '0600',
                'networkName': 'crm_internal',
                'networkProjectLabel': 'crm',
                'networkComposeLabel': 'internal',
                'alias': 'postgres',
                'runnerNetworkCount': 1,
                'containerIdentityStable': True,
                'credentialsPrinted': False,
                'credentialsInArguments': False,
            },
            'image': {'ref': EXPECTED_GATEWAY_REF, 'digestBound': True},
            'freshBackup': {
                'directory': '/var/backups/personal-max-stage8b2a-pre-migration-20260728T120000Z',
                'dumpSha256': '7' * 64,
                'dumpBytes': 100,
                'objectCount': 581,
                'configArchiveSha256': '6' * 64,
                'status': 'VALIDATED',
                'structuralValidation': 'PASS',
            },
            'migration': {
                'before': {'total': 46, 'finished': 46, 'failed': 0},
                'after': {'total': 54, 'finished': 54, 'failed': 0},
                'appliedNames': list(EXPECTED_MIGRATIONS),
                'acceptedLedgerOnlyMigrations': list(EXPECTED_LEDGER_ONLY),
                'rawRows': 0,
                'prismaDiffEmpty': False,
                'prismaDiffStatus': 'ACCEPTED_LEGACY_DRIVER_TELEGRAM_COLUMNS',
                'prismaDiffRawSqlIncluded': False,
            },
            'schema': {
                'rawJournalConstraints': [
                    'MaxRawTransportEvent_payloadSizeBytes_check',
                    'MaxRawTransportEvent_quarantineConsistency_check',
                    'MaxRawTransportEvent_replayAvailability_check',
                ],
                'appendOnlyTrigger': 'MaxRawTransportEvent_append_only',
                'appendOnlyFunction': 'max_raw_transport_event_append_only_guard',
            },
            'runners': {
                'migration': {'name': 'personal-max-stage8b2a-migration-runner', 'cleanupState': 'ABSENT_AFTER_SUCCESS'},
                'prismaDiff': {'name': 'personal-max-stage8b2a-prisma-diff-runner', 'cleanupState': 'ABSENT_AFTER_SUCCESS'},
                'allOwnedRunnersAbsent': True,
            },
            'production': {
                'containerHashBefore': '5' * 64,
                'containerHashAfter': '5' * 64,
                'restartCountsUnchanged': True,
                'gitUnchanged': True,
            },
            'storage': {'freeBytesBefore': 20_000_000_000, 'freeBytesAfter': 19_000_000_000, 'rollbackReserveBytes': ROLLBACK_RESERVE_BYTES},
            'safety': dict(EXACT_MIGRATION_SAFETY),
        },
    }


def dormant_binding(migration):
    return {
        'sha256': '4' * 64,
        'evidence': {
            'schemaVersion': 1,
            'mode': 'DORMANT_GATEWAY_ROLLOUT',
            'script': {'sha256': EXPECTED_DORMANT_SCRIPT_SHA, 'checksumBound': True},
            'bindings': {
                'isolatedReportSha256': migration['evidence']['bindings']['isolatedReportSha256'],
                'migrationReportSha256': migration['sha256'],
                'migrationScriptSha256': EXPECTED_MIGRATION_SCRIPT_SHA,
            },
            'acceptedMigration': {
                'reportValidated': True,
                'productionMigrationScriptSha256': EXPECTED_MIGRATION_SCRIPT_SHA,
                'gatewayImage': EXPECTED_GATEWAY_REF,
                'isolatedReportShaCrossBound': True,
                'freshBackupStatus': 'VALIDATED',
                'appliedCount': len(EXPECTED_MIGRATIONS),
                'runnerCleanup': 'PASS',
                'safety': 'PASS',
                'databaseBinding': 'POSTGRES_IDENTITY_FENCED',
                'prismaDiffEmpty': False,
                'prismaDiffStatus': 'ACCEPTED_LEGACY_DRIVER_TELEGRAM_COLUMNS',
                'prismaDiffRawSqlIncluded': False,
                'acceptedLedgerOnlyMigrations': list(EXPECTED_LEDGER_ONLY),
            },
            'image': {'ref': EXPECTED_GATEWAY_REF, 'runtimeUser': '1000:1000'},
            'runtime': {
                'container': 'personal-max-dormant-gateway',
                'network': 'personal-max-stage8b2b-dormant',
                'networkInternal': True,
                'publicPorts': 0,
                'mounts': 0,
                'health': 'PASS',
                'readiness': 'dormant-ready',
                'restartPolicy': 'unless-stopped',
            },
            'behavior': {
                'databaseConfigured': False,
                'databaseWrites': 0,
                'captureEnabled': False,
                'senderActive': False,
                'browserLaunched': False,
                'maxContacted': False,
                'providerAction': False,
            },
            'production': {'hashBefore': '3' * 64, 'hashAfter': '3' * 64, 'unchanged': True, 'restartCountsUnchanged': True},
            'storage': {'freeBytesBefore': 19_000_000_000},
            'rollback': {
                'available': True,
                'automatic': False,
                'scriptSha256': EXPECTED_DORMANT_ROLLBACK_SHA,
                'composeSha256': EXPECTED_DORMANT_COMPOSE_SHA,
            },
        },
    }


def base(target, accounts):
    active = target in ('one-account', 'ab')
    scraper_required = target != 'dormant'
    total_rows = sum(item['rawJournalRows'] for item in accounts)
    migration = migration_binding()
    dormant = dormant_binding(migration)
    return {
        'schemaVersion': 2,
        'mode': 'SHADOW_OBSERVATION',
        'target': target,
        'script': {'sha256': 'd' * 64, 'checksumBound': True},
        'bindings': {'migrationReport': migration, 'dormantRolloutReport': dormant},
        'window': {'mode': '5m', 'startEpoch': 1000, 'endEpoch': 1300, 'seconds': 300},
        'release': {
            'expectedImageSourceCommit': EXPECTED_SOURCE_COMMIT,
            'gatewaySourceRevision': EXPECTED_SOURCE_COMMIT,
            'scraperSourceRevision': EXPECTED_SOURCE_COMMIT if scraper_required else None,
        },
        'database': {
            'schemaVersion': 2,
            'databaseSnapshotIdentity': '100:100:',
            'window': {'startEpoch': 1000, 'endEpoch': 1300, 'seconds': 300},
            'accountCount': len(accounts),
            'accounts': accounts,
            'totals': {'rawJournalRows': total_rows, 'rawJournalRowsPerSecond': round(sum(item['rawJournalRowsPerSecond'] for item in accounts), 6)},
            'activity': {'active_sessions': 0, 'long_transactions': 0},
            'locks': {'waiting_locks': 0},
            'schemaState': {
                'migrationLedger': {
                    'total': 54,
                    'finished': 54,
                    'failed': 0,
                    'appliedExpectedMigrations': sorted(EXPECTED_MIGRATIONS),
                },
                'rawJournal': {
                    'relationKind': 'r',
                    'constraints': sorted([
                        'MaxRawTransportEvent_payloadSizeBytes_check',
                        'MaxRawTransportEvent_quarantineConsistency_check',
                        'MaxRawTransportEvent_replayAvailability_check',
                    ]),
                    'expectedConstraintDefinitionsExact': True,
                    'appendOnlyTriggerPresent': True,
                    'appendOnlyContractExact': True,
                },
            },
        },
        'runtime': {
            'gateway': {
                'containerId': '1' * 64,
                'containerState': 'running',
                'dockerHealth': 'healthy',
                'restartCount': 0,
                'image': image(EXPECTED_GATEWAY_REF),
                'sourceRevision': EXPECTED_SOURCE_COMMIT,
                'lifecycle': 'checksum-bound-compose',
                'startedAtEpoch': 900,
                'runtimeUser': '1000:1000',
                'restartPolicy': 'unless-stopped',
                'publicPortBindings': 0,
                'mountCount': 0,
                'networkNames': [EXPECTED_DORMANT_NETWORK],
                'expectedNetworkInternal': True,
                'composeIdentity': dict(EXPECTED_COMPOSE_IDENTITY),
                'securityConfig': {
                    'readonlyRootfs': True,
                    'privileged': False,
                    'capDrop': ['ALL'],
                    'capAdd': [],
                    'securityOpt': ['no-new-privileges:true'],
                    'init': True,
                    'pidsLimit': 128,
                },
                'http': {
                    'healthStatus': 200,
                    'mode': 'active' if active else 'dormant',
                    'enabledAccountCount': len(accounts) if active else 0,
                    'enabledAccountAliases': sorted(item['alias'] for item in accounts) if active else [],
                    'accountIdentityStatus': 'OBSERVED_HASHED_RUNTIME_ACCOUNT_SCOPE' if active else 'EMPTY_SCOPE_CONFIRMED',
                    'readinessStatus': 200,
                    'readinessState': 'ready' if active else 'dormant-ready',
                    'senderModulesInactive': True,
                    'providerActionsInactive': True,
                },
            },
            'scraper': {
                'requiredForTarget': scraper_required,
                'observed': scraper_required,
                'observationStatus': 'OBSERVED' if scraper_required else 'NOT_IN_TARGET_SCOPE',
                **({'containerId': '2' * 64} if scraper_required else {}),
                'containerCount': 1 if scraper_required else None,
                'containerState': 'running' if scraper_required else None,
                'dockerHealth': 'healthy' if scraper_required else None,
                'restartCount': 0 if scraper_required else None,
                'startedAtEpoch': 900 if scraper_required else None,
                'image': image(EXPECTED_SCRAPER_REF) if scraper_required else None,
                'sourceRevision': EXPECTED_SOURCE_COMMIT if scraper_required else None,
                'profileMount': {'destination': '/app/user_data', 'exactCount': 1, 'readWrite': True} if scraper_required else None,
                'existingFlowHealthy': True if target == 'default-off' else None,
            },
        },
        'runtimeCounters': {
            'scope': 'gateway_process_lifetime',
            'metricsComplete': True,
            'captureAcceptedEnvelopes': total_rows,
            'idempotentRetries': 0,
            'lostBeforeSpool': 0,
            'wrongAccount': 0,
            'criticalRegressions': 0,
            'drainFailures': 0,
            'spoolPending': 0,
            'spoolBytes': 0,
            'oldestSpoolAgeMs': 0,
            'spoolLimitBytes': 268435456 if active else 0,
            'spoolLimitEvidence': 'SOURCE_BOUND_CONTRACT' if active else 'NOT_REQUIRED_FOR_TARGET',
        },
        'ownership': {
            'browserOwnersObserved': 1 if scraper_required else None,
            'browserOwnershipStatus': 'OBSERVED_EXACT_RUNTIME_METADATA' if scraper_required else 'UNKNOWN_REQUIRES_SEPARATE_AUTHORIZED_RUNTIME_METADATA',
            'listenerOwnersObserved': 1 if scraper_required else None,
            'listenerOwnershipStatus': 'OBSERVED_EXACT_RUNTIME_METADATA' if scraper_required else 'UNKNOWN_REQUIRES_SEPARATE_AUTHORIZED_RUNTIME_METADATA',
        },
        'observability': {
            'physicalFrames': {
                'count': total_rows if active else None,
                'status': 'OBSERVED_WINDOW_ALIGNED' if active else 'UNKNOWN_NO_WINDOW_ALIGNED_PHYSICAL_FRAME_SOURCE',
                'rawJournalRowsAreNotPhysicalFrames': True,
            },
        },
        'disk': {'dockerRoot': '/var/lib/docker', 'freeBytes': 20_000_000_000, 'rollbackReserveBytes': ROLLBACK_RESERVE_BYTES, 'belowReserve': False},
        'sourceContracts': {
            'projectionDisabled': {
                'value': True,
                'factKind': 'SOURCE_BOUND_CONTRACT',
                'runtimeObserved': False,
                'sourceCommit': EXPECTED_SOURCE_COMMIT,
                'appliesToObservedGateway': True,
                'files': [{'path': path, 'sha256': checksum} for path, checksum in EXPECTED_PROJECTION_FILES.items()],
            },
            'senderDisabled': {'value': True, 'runtimeReadinessObserved': True},
            'providerActionsInactive': {'value': True, 'runtimeReadinessObserved': True},
        },
        'recoveryEvidence': {
            'reconnectRecovery': True if active else None,
            'restartRecovery': True if active else None,
            'status': 'OBSERVED_SEPARATELY_AUTHORIZED' if active else 'NOT_EXECUTED_REQUIRES_SEPARATE_AUTHORIZATION',
        },
        'privacy': dict(EXACT_PRIVACY),
        'safety': dict(EXACT_SAFETY),
        'action': {'rollbackExecuted': False, 'enablementFrozen': False},
    }


checks = 0


def expect(report, target, verdict, trigger=None):
    global checks
    result = evaluate(report, target)
    assert result['verdict'] == verdict, result
    if trigger is not None:
        assert trigger in result['triggers'], result
    checks += 1


def never_accept(report, target):
    global checks
    result = evaluate(report, target)
    assert result['verdict'] != 'ACCEPT', result
    checks += 1


def mutation(target='dormant'):
    fixtures = []

    def add(path, value):
        report = base(target, [] if target == 'dormant' else [account(rows=0)])
        cursor = report
        for key in path[:-1]:
            cursor = cursor[key]
        cursor[path[-1]] = value
        fixtures.append(report)

    add(('window', 'endEpoch'), 1299)
    add(('database', 'window', 'startEpoch'), 999)
    add(('database', 'totals', 'rawJournalRows'), 1)
    add(('disk', 'belowReserve'), True)
    add(('disk', 'freeBytes'), 1)
    add(('release', 'expectedImageSourceCommit'), '0' * 40)
    add(('release', 'gatewaySourceRevision'), '0' * 40)
    add(('runtime', 'gateway', 'image', 'configuredRef'), 'mutable:latest')
    add(('runtime', 'gateway', 'image', 'acceptedDigestPresent'), False)
    add(('runtime', 'gateway', 'lifecycle'), 'unbound')
    add(('runtime', 'gateway', 'startedAtEpoch'), 1100)
    add(('runtime', 'gateway', 'runtimeUser'), '0:0')
    add(('runtime', 'gateway', 'restartPolicy'), 'always')
    add(('runtime', 'gateway', 'publicPortBindings'), 1)
    add(('runtime', 'gateway', 'mountCount'), 1)
    add(('runtime', 'gateway', 'networkNames'), ['bridge'])
    add(('runtime', 'gateway', 'expectedNetworkInternal'), False)
    add(('runtime', 'gateway', 'composeIdentity', 'project'), 'forged')
    add(('runtime', 'gateway', 'securityConfig', 'readonlyRootfs'), False)
    add(('runtime', 'gateway', 'securityConfig', 'privileged'), True)
    add(('database', 'schemaState', 'migrationLedger', 'total'), 55)
    add(('database', 'schemaState', 'rawJournal', 'expectedConstraintDefinitionsExact'), False)
    add(('database', 'schemaState', 'rawJournal', 'appendOnlyContractExact'), False)
    add(('safety', 'providerAction'), True)
    add(('safety', 'databaseReadOnly'), False)
    add(('action', 'rollbackExecuted'), True)
    add(('bindings', 'migrationReport', 'evidence', 'script', 'sha256'), '0' * 64)
    add(('bindings', 'migrationReport', 'evidence', 'bindings', 'acceptedBackupReportSha256'), '0' * 64)
    add(('bindings', 'migrationReport', 'evidence', 'databaseBinding', 'containerIdentityStable'), False)
    add(('bindings', 'migrationReport', 'evidence', 'databaseBinding', 'credentialsInArguments'), True)
    add(('bindings', 'migrationReport', 'evidence', 'databaseBinding', 'networkComposeLabel'), 'public')
    add(('bindings', 'migrationReport', 'evidence', 'migration', 'appliedNames'), EXPECTED_MIGRATIONS[:-1])
    add(('bindings', 'migrationReport', 'evidence', 'migration', 'acceptedLedgerOnlyMigrations'), [])
    add(('bindings', 'migrationReport', 'evidence', 'migration', 'prismaDiffRawSqlIncluded'), True)
    add(('bindings', 'migrationReport', 'evidence', 'schema', 'appendOnlyTrigger'), 'missing')
    add(('bindings', 'migrationReport', 'evidence', 'runners', 'allOwnedRunnersAbsent'), False)
    add(('bindings', 'migrationReport', 'evidence', 'freshBackup', 'status'), 'CREATED_UNVALIDATED')
    add(('bindings', 'migrationReport', 'evidence', 'production', 'gitUnchanged'), False)
    add(('bindings', 'migrationReport', 'evidence', 'safety', 'deploy'), True)
    add(('bindings', 'dormantRolloutReport', 'evidence', 'script', 'sha256'), '0' * 64)
    add(('bindings', 'dormantRolloutReport', 'evidence', 'bindings', 'migrationReportSha256'), '0' * 64)
    add(('bindings', 'dormantRolloutReport', 'evidence', 'bindings', 'isolatedReportSha256'), '0' * 64)
    add(('bindings', 'dormantRolloutReport', 'evidence', 'bindings', 'migrationScriptSha256'), '0' * 64)
    add(('bindings', 'dormantRolloutReport', 'evidence', 'acceptedMigration', 'reportValidated'), False)
    add(('bindings', 'dormantRolloutReport', 'evidence', 'acceptedMigration', 'productionMigrationScriptSha256'), '0' * 64)
    add(('bindings', 'dormantRolloutReport', 'evidence', 'acceptedMigration', 'gatewayImage'), 'mutable:latest')
    add(('bindings', 'dormantRolloutReport', 'evidence', 'acceptedMigration', 'isolatedReportShaCrossBound'), False)
    add(('bindings', 'dormantRolloutReport', 'evidence', 'acceptedMigration', 'freshBackupStatus'), 'UNVALIDATED')
    add(('bindings', 'dormantRolloutReport', 'evidence', 'acceptedMigration', 'appliedCount'), 7)
    add(('bindings', 'dormantRolloutReport', 'evidence', 'acceptedMigration', 'runnerCleanup'), 'FAIL')
    add(('bindings', 'dormantRolloutReport', 'evidence', 'acceptedMigration', 'safety'), 'FAIL')
    add(('bindings', 'dormantRolloutReport', 'evidence', 'acceptedMigration', 'databaseBinding'), 'UNTRUSTED')
    add(('bindings', 'dormantRolloutReport', 'evidence', 'acceptedMigration', 'prismaDiffRawSqlIncluded'), True)
    add(('bindings', 'dormantRolloutReport', 'evidence', 'acceptedMigration', 'acceptedLedgerOnlyMigrations'), [])
    add(('bindings', 'dormantRolloutReport', 'evidence', 'image', 'ref'), 'mutable:latest')
    add(('bindings', 'dormantRolloutReport', 'evidence', 'image', 'runtimeUser'), '0:0')
    add(('bindings', 'dormantRolloutReport', 'evidence', 'runtime', 'networkInternal'), False)
    add(('bindings', 'dormantRolloutReport', 'evidence', 'runtime', 'publicPorts'), 1)
    add(('bindings', 'dormantRolloutReport', 'evidence', 'runtime', 'mounts'), 1)
    add(('bindings', 'dormantRolloutReport', 'evidence', 'runtime', 'health'), 'FAIL')
    add(('bindings', 'dormantRolloutReport', 'evidence', 'runtime', 'readiness'), 'not-ready')
    add(('bindings', 'dormantRolloutReport', 'evidence', 'runtime', 'restartPolicy'), 'always')
    add(('bindings', 'dormantRolloutReport', 'evidence', 'behavior', 'databaseConfigured'), True)
    add(('bindings', 'dormantRolloutReport', 'evidence', 'behavior', 'databaseWrites'), 1)
    add(('bindings', 'dormantRolloutReport', 'evidence', 'behavior', 'captureEnabled'), True)
    add(('bindings', 'dormantRolloutReport', 'evidence', 'behavior', 'senderActive'), True)
    add(('bindings', 'dormantRolloutReport', 'evidence', 'behavior', 'browserLaunched'), True)
    add(('bindings', 'dormantRolloutReport', 'evidence', 'behavior', 'maxContacted'), True)
    add(('bindings', 'dormantRolloutReport', 'evidence', 'behavior', 'providerAction'), True)
    add(('bindings', 'dormantRolloutReport', 'evidence', 'production', 'unchanged'), False)
    add(('bindings', 'dormantRolloutReport', 'evidence', 'production', 'restartCountsUnchanged'), False)
    add(('bindings', 'dormantRolloutReport', 'evidence', 'storage', 'freeBytesBefore'), 0)
    add(('bindings', 'dormantRolloutReport', 'evidence', 'rollback', 'available'), False)
    add(('bindings', 'dormantRolloutReport', 'evidence', 'rollback', 'automatic'), True)
    add(('bindings', 'dormantRolloutReport', 'evidence', 'rollback', 'scriptSha256'), '0' * 64)
    add(('bindings', 'dormantRolloutReport', 'evidence', 'rollback', 'composeSha256'), '0' * 64)
    return fixtures


expect(base('dormant', []), 'dormant', 'ACCEPT')
expect(base('default-off', [account(rows=0)]), 'default-off', 'FREEZE_ENABLEMENT', 'default_off_external_evidence_binding_missing')
expect(base('one-account', [account(rows=10, comparisons=10)]), 'one-account', 'FREEZE_ENABLEMENT', 'active_external_evidence_binding_missing')
expect(base('ab', [account('a', 10, 10), account('b', 12, 12)]), 'ab', 'FREEZE_ENABLEMENT', 'active_external_evidence_binding_missing')

default_listener = base('default-off', [account(rows=0)])
default_listener['ownership']['listenerOwnersObserved'] = None
default_listener['ownership']['listenerOwnershipStatus'] = 'UNKNOWN_REQUIRES_SEPARATE_AUTHORIZED_RUNTIME_METADATA'
expect(default_listener, 'default-off', 'FREEZE_ENABLEMENT', 'listener_ownership_unproven')

duplicate = base('one-account', [account(rows=10, comparisons=10)])
duplicate['database']['accounts'][0]['accidentalDuplicateEnvelopes'] = 1
expect(duplicate, 'one-account', 'FREEZE_ENABLEMENT', 'accidental_duplicate')

wrong = base('ab', [account('a', 10, 10), account('b', 10, 10)])
wrong['runtimeCounters']['wrongAccount'] = 1
expect(wrong, 'ab', 'FREEZE_ENABLEMENT', 'wrong_account')

critical = base('one-account', [account(rows=10, comparisons=10)])
critical['database']['accounts'][0]['semanticRegressions'] = 1
critical['database']['accounts'][0]['criticalRegressions'] = 1
expect(critical, 'one-account', 'FREEZE_ENABLEMENT', 'critical_semantic_regression')

spool = base('one-account', [account(rows=10, comparisons=10)])
spool['runtimeCounters']['spoolBytes'] = 200_000_000
expect(spool, 'one-account', 'FREEZE_ENABLEMENT', 'spool_threshold')

missing_metric = base('one-account', [account(rows=10, comparisons=10)])
missing_metric['runtimeCounters']['lostBeforeSpool'] = None
missing_metric['runtimeCounters']['metricsComplete'] = False
expect(missing_metric, 'one-account', 'FREEZE_ENABLEMENT', 'runtime_metrics_unknown')

for adversarial in mutation():
    never_accept(adversarial, 'dormant')

cardinality = base('dormant', [])
cardinality['database']['accountCount'] = 1
never_accept(cardinality, 'dormant')

alias = base('one-account', [account(rows=10, comparisons=10)])
alias['database']['accounts'][0]['alias'] = 'raw-account-id'
never_accept(alias, 'one-account')

metric_lie = base('one-account', [account(rows=10, comparisons=10)])
metric_lie['runtimeCounters']['lostBeforeSpool'] = None
never_accept(metric_lie, 'one-account')

critical_diff = base('one-account', [account(rows=10, comparisons=10)])
critical_diff['database']['accounts'][0]['criticalDiffs'] = 1
expect(critical_diff, 'one-account', 'FREEZE_ENABLEMENT', 'critical_semantic_regression')

capture_zero = base('one-account', [account(rows=10, comparisons=10)])
capture_zero['runtimeCounters']['captureAcceptedEnvelopes'] = 0
expect(capture_zero, 'one-account', 'FREEZE_ENABLEMENT', 'capture_counter_inconsistent')

frames_zero = base('one-account', [account(rows=10, comparisons=10)])
frames_zero['observability']['physicalFrames']['count'] = 0
expect(frames_zero, 'one-account', 'FREEZE_ENABLEMENT', 'physical_frame_observability_unproven')

frames_fractional = base('one-account', [account(rows=10, comparisons=10)])
frames_fractional['observability']['physicalFrames']['count'] = 1.5
never_accept(frames_fractional, 'one-account')

normalization_lie = base('one-account', [account(rows=10, comparisons=10)])
normalization_lie['database']['accounts'][0]['normalizationResults'] = 999
never_accept(normalization_lie, 'one-account')

latency_lie = base('one-account', [account(rows=10, comparisons=10)])
latency_lie['database']['accounts'][0]['journalLatencyMs'] = {'p50': 3, 'p95': 2, 'p99': 1}
never_accept(latency_lie, 'one-account')

spool_lie = base('one-account', [account(rows=10, comparisons=10)])
spool_lie['runtimeCounters']['spoolPending'] = 10
spool_lie['runtimeCounters']['spoolBytes'] = 0
spool_lie['runtimeCounters']['oldestSpoolAgeMs'] = 400_000
expect(spool_lie, 'one-account', 'FREEZE_ENABLEMENT', 'spool_metrics_inconsistent')

counter_fractional = base('one-account', [account(rows=10, comparisons=10)])
counter_fractional['runtimeCounters']['captureAcceptedEnvelopes'] = 10.5
never_accept(counter_fractional, 'one-account')

account_identity_lie = base('one-account', [account(rows=10, comparisons=10)])
account_identity_lie['runtime']['gateway']['http']['enabledAccountAliases'] = ['b' * 64]
expect(account_identity_lie, 'one-account', 'FREEZE_ENABLEMENT', 'gateway_account_identity_unproven')

scraper_replaced = base('default-off', [account(rows=0)])
scraper_replaced['runtime']['scraper']['startedAtEpoch'] = 1100
expect(scraper_replaced, 'default-off', 'FREEZE_ENABLEMENT', 'scraper_started_after_window_start')

clean_final = base('dormant', [])
clean_final['evaluation'] = evaluate(clean_final, 'dormant')
clean_final['action']['enablementFrozen'] = clean_final['evaluation']['freezeEnablement']
assert validate_final_report(clean_final, 'dormant')
checks += 1

final_verdict_lie = deepcopy(clean_final)
final_verdict_lie['evaluation']['verdict'] = 'FREEZE_ENABLEMENT'
assert not validate_final_report(final_verdict_lie, 'dormant')
checks += 1

final_action_lie = deepcopy(clean_final)
final_action_lie['action']['enablementFrozen'] = True
assert not validate_final_report(final_action_lie, 'dormant')
checks += 1

final_safety_lie = deepcopy(clean_final)
final_safety_lie['safety']['providerAction'] = True
assert not validate_final_report(final_safety_lie, 'dormant')
checks += 1

final_extra = deepcopy(clean_final)
final_extra['evaluation']['unexpected'] = True
assert not validate_final_report(final_extra, 'dormant')
checks += 1

report_schema = json.loads((Path(__file__).resolve().parent / 'report-schema.json').read_text(encoding='utf-8'))
jsonschema.validate(clean_final, report_schema)
checks += 1
schema_binding_lie = deepcopy(clean_final)
schema_binding_lie['bindings']['migrationReport']['evidence']['databaseBinding']['credentialsPrinted'] = True
try:
    jsonschema.validate(schema_binding_lie, report_schema)
except jsonschema.ValidationError:
    checks += 1
else:
    raise AssertionError('report schema accepted unsafe database binding')

expect({}, 'one-account', 'MALFORMED_REPORT', 'malformed_report')
expect(base('one-account', [account(rows=10, comparisons=10)]), 'ab', 'MALFORMED_REPORT', 'malformed_report')

print(f'PHASE_E_EVALUATOR_PASS={checks}')
