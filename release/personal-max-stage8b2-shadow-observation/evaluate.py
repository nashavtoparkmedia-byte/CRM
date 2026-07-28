#!/usr/bin/env python3
import copy
import json
import math
import re
import sys

TARGETS = {'dormant', 'default-off', 'one-account', 'ab'}
WINDOWS = {'5m': 300, '30m': 1800, '2h': 7200, '24h': 86400}
EXPECTED_GATEWAY_REF = 'ghcr.io/nashavtoparkmedia-byte/crm-max-personal-gateway@sha256:dd718fd8e9e2ec52a0ee1c19b576d75a1035f9e251980351ebc04071dfe5d0de'
EXPECTED_SCRAPER_REF = 'ghcr.io/nashavtoparkmedia-byte/crm-max-web-scraper@sha256:abf4405f55ab1c84f319b00cdb8b561f76353001ba2543045fddb17dc6b46768'
EXPECTED_SOURCE_COMMIT = '33eb40b87f77eee16fbf4ccd06a667ea4ce51e5a'
EXPECTED_DORMANT_NETWORK = 'personal-max-stage8b2b-dormant'
EXPECTED_COMPOSE_IDENTITY = {
    'project': 'personal-max-stage8b2b',
    'service': 'gateway',
    'stage': '8b2b',
    'mode': 'dormant',
}
EXPECTED_MIGRATION_SCRIPT_SHA = 'f054d48ab8b5a93911057c9a9dd6123c48fc91720dd50dcb32c833d3718b9560'
EXPECTED_DORMANT_SCRIPT_SHA = 'bc8ee9ac2012f04d66113db604ea13ce204bd3400fa6eedb7f22531be25cb6f3'
EXPECTED_DORMANT_ROLLBACK_SHA = '41a6e1962ae38c4946c0e2e1a82ae84dd08fae06dac934b8d2b95a3f519b2a7d'
EXPECTED_DORMANT_COMPOSE_SHA = '3f9656117f5da8db510a9710744263384619aa371cac6fa7c8a7d3e50a352ca2'
EXPECTED_BACKUP_REPORT_SHA = 'f9b29d5fbe69b9a87d402bab3a19a1079797640549078b17a6ba8e7280415566'
EXPECTED_LEDGER_ONLY = ['20260717000000_add_driver_telegram_submitted_phone']
EXPECTED_MIGRATIONS = [
    '20260726162043_add_max_raw_transport_journal',
    '20260726190658_add_max_route_registry',
    '20260726205437_add_max_inbound_normalization',
    '20260726215715_add_max_per_chat_outbound_actor',
    '20260726225737_add_max_dispatch_ledger',
    '20260727053744_add_max_provider_confirmation_matcher',
    '20260727141925_add_max_shadow_semantic_comparison',
    '20260727154647_add_max_capture_ingress',
]
EXPECTED_PROJECTION_FILES = {
    'max-personal-gateway/src/runtime/main.ts': '8c73af79aa02d7ad620161b8d5ada465a041f09f86f957c1effcd5956b14e4ca',
    'max-personal-gateway/src/runtime/ShadowPipeline.ts': '7385c7339ab999b536f64bc5afe3910792021a8e47430ec5e2c4dbb13c58e90a',
    'max-personal-gateway/src/runtime/config.ts': 'cb5fc7851cfb5623316d4215c98b42a2b0b32955d5da3839fa65ea6a334ff79c',
}
ROLLBACK_RESERVE_BYTES = 5368709120
HEX_40 = re.compile(r'^[0-9a-f]{40}$')
HEX_64 = re.compile(r'^[0-9a-f]{64}$')
BACKUP_DIRECTORY = re.compile(r'^/var/backups/personal-max-stage8b2a-pre-migration-[0-9]{8}T[0-9]{6}Z$')

BASE_KEYS = {
    'schemaVersion', 'mode', 'target', 'script', 'bindings', 'window', 'release',
    'database', 'runtime', 'runtimeCounters', 'ownership', 'observability', 'disk',
    'sourceContracts', 'recoveryEvidence', 'privacy', 'safety', 'action',
}
ACCOUNT_KEYS = {
    'alias', 'rawJournalRows', 'rawJournalRowsPerSecond', 'accidentalDuplicateEnvelopes',
    'rawQuarantined', 'normalizationResults', 'normalizationQuarantined',
    'normalizationUnsupported', 'semanticComparisons', 'semanticRegressions',
    'criticalRegressions', 'criticalDiffs', 'routeIdentityCritical',
    'openRouteConflicts', 'unprocessedRows', 'oldestUnprocessedSeconds', 'journalLatencyMs',
}
COUNTER_KEYS = {
    'scope', 'metricsComplete', 'captureAcceptedEnvelopes', 'idempotentRetries',
    'lostBeforeSpool', 'wrongAccount', 'criticalRegressions', 'drainFailures',
    'spoolPending', 'spoolBytes', 'oldestSpoolAgeMs', 'spoolLimitBytes', 'spoolLimitEvidence',
}
REQUIRED_COUNTERS = (
    'captureAcceptedEnvelopes', 'idempotentRetries', 'lostBeforeSpool', 'wrongAccount',
    'criticalRegressions', 'drainFailures', 'spoolPending', 'spoolBytes', 'oldestSpoolAgeMs',
)
EXACT_PRIVACY = {
    'messageText': False, 'payload': False, 'phone': False, 'displayName': False,
    'contactData': False, 'providerPayload': False, 'credentials': False,
    'hmac': False, 'rawAccountId': False,
}
EXACT_SAFETY = {
    'databaseReadOnly': True, 'statementTimeoutMs': 5000, 'lockTimeoutMs': 1000,
    'ddl': False, 'dml': False, 'dockerMutation': False, 'deploy': False,
    'restart': False, 'browserLaunched': False, 'maxContacted': False,
    'providerAction': False, 'secretsPrinted': False,
    'environmentValuesInspected': False, 'rawAccountIdPrinted': False,
}
EXACT_MIGRATION_SAFETY = {
    'deploy': False, 'restart': False, 'captureEnabled': False, 'gatewayStarted': False,
    'scraperChanged': False, 'destructiveRollback': False, 'secretsPrinted': False,
    'providerAction': False, 'maxContacted': False,
}


def nonnegative(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def nonnegative_integer(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def exact_keys(value, keys):
    return isinstance(value, dict) and set(value) == set(keys)


def sha256(value):
    return isinstance(value, str) and HEX_64.fullmatch(value) is not None


def malformed():
    return {
        'verdict': 'MALFORMED_REPORT',
        'freezeEnablement': True,
        'triggers': ['malformed_report'],
        'recommendedAction': 'REVIEW_OBSERVER_REPORT',
        'rollbackExecuted': False,
    }


def valid_image(image, expected_ref):
    if not exact_keys(image, {'acceptedRef', 'configuredRef', 'imageId', 'repoDigests', 'acceptedDigestPresent'}):
        return False
    digests = image['repoDigests']
    return (
        image['acceptedRef'] == expected_ref
        and image['configuredRef'] == expected_ref
        and isinstance(image['imageId'], str)
        and re.fullmatch(r'^sha256:[0-9a-f]{64}$', image['imageId']) is not None
        and isinstance(digests, list) and len(digests) == len(set(digests))
        and all(isinstance(item, str) for item in digests)
        and image['acceptedDigestPresent'] is (expected_ref in digests)
    )


def valid_database_binding(binding):
    keys = {
        'source', 'projectLabel', 'serviceLabel', 'envKeys', 'urlHost', 'urlPort',
        'urlSchema', 'inspectMode', 'envMode', 'networkName', 'networkProjectLabel',
        'networkComposeLabel', 'alias', 'runnerNetworkCount', 'containerIdentityStable',
        'credentialsPrinted', 'credentialsInArguments',
    }
    return (
        exact_keys(binding, keys)
        and binding['source'] == 'postgres-container-env'
        and binding['projectLabel'] == 'crm'
        and binding['serviceLabel'] == 'postgres'
        and binding['envKeys'] == ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB']
        and binding['urlHost'] == 'postgres'
        and binding['urlPort'] == 5432
        and binding['urlSchema'] == 'public'
        and binding['inspectMode'] == '0600'
        and binding['envMode'] == '0600'
        and isinstance(binding['networkName'], str) and len(binding['networkName']) > 0
        and binding['networkProjectLabel'] == 'crm'
        and binding['networkComposeLabel'] == 'internal'
        and binding['alias'] == 'postgres'
        and binding['runnerNetworkCount'] == 1
        and binding['containerIdentityStable'] is True
        and binding['credentialsPrinted'] is False
        and binding['credentialsInArguments'] is False
    )


def valid_migration_evidence(binding):
    if not exact_keys(binding, {'sha256', 'evidence'}) or not sha256(binding['sha256']):
        return False
    evidence = binding['evidence']
    if not exact_keys(evidence, {'schemaVersion', 'mode', 'script', 'bindings', 'databaseBinding', 'image', 'freshBackup', 'migration', 'schema', 'runners', 'production', 'storage', 'safety'}):
        return False
    if evidence['schemaVersion'] != 1 or evidence['mode'] != 'PRODUCTION_MIGRATION_EVIDENCE':
        return False
    if evidence['script'] != {'sha256': EXPECTED_MIGRATION_SCRIPT_SHA, 'checksumBound': True}:
        return False
    bindings = evidence['bindings']
    if not exact_keys(bindings, {'isolatedReportSha256', 'acceptedBackupReportSha256'}):
        return False
    if not sha256(bindings['isolatedReportSha256']) or bindings['acceptedBackupReportSha256'] != EXPECTED_BACKUP_REPORT_SHA:
        return False
    if not valid_database_binding(evidence['databaseBinding']):
        return False
    if evidence['image'] != {'ref': EXPECTED_GATEWAY_REF, 'digestBound': True}:
        return False
    backup = evidence['freshBackup']
    if not exact_keys(backup, {'directory', 'dumpSha256', 'dumpBytes', 'objectCount', 'configArchiveSha256', 'status', 'structuralValidation'}):
        return False
    if (
        backup['status'] != 'VALIDATED' or backup['structuralValidation'] != 'PASS'
        or not isinstance(backup['directory'], str) or BACKUP_DIRECTORY.fullmatch(backup['directory']) is None
        or not sha256(backup['dumpSha256']) or not sha256(backup['configArchiveSha256'])
        or not nonnegative_integer(backup['dumpBytes']) or backup['dumpBytes'] <= 0
        or not nonnegative_integer(backup['objectCount']) or backup['objectCount'] <= 0
    ):
        return False
    migration = evidence['migration']
    if not exact_keys(migration, {'before', 'after', 'appliedNames', 'acceptedLedgerOnlyMigrations', 'rawRows', 'prismaDiffEmpty', 'prismaDiffStatus', 'prismaDiffRawSqlIncluded'}):
        return False
    if (
        migration['before'] != {'total': 46, 'finished': 46, 'failed': 0}
        or migration['after'] != {'total': 54, 'finished': 54, 'failed': 0}
        or migration['appliedNames'] != EXPECTED_MIGRATIONS
        or migration['acceptedLedgerOnlyMigrations'] != EXPECTED_LEDGER_ONLY
        or migration['rawRows'] != 0 or migration['prismaDiffEmpty'] is not False
        or migration['prismaDiffStatus'] != 'ACCEPTED_LEGACY_DRIVER_TELEGRAM_COLUMNS'
        or migration['prismaDiffRawSqlIncluded'] is not False
    ):
        return False
    if evidence['schema'] != {
        'rawJournalConstraints': [
            'MaxRawTransportEvent_payloadSizeBytes_check',
            'MaxRawTransportEvent_quarantineConsistency_check',
            'MaxRawTransportEvent_replayAvailability_check',
        ],
        'appendOnlyTrigger': 'MaxRawTransportEvent_append_only',
        'appendOnlyFunction': 'max_raw_transport_event_append_only_guard',
    }:
        return False
    if evidence['runners'] != {
        'migration': {'name': 'personal-max-stage8b2a-migration-runner', 'cleanupState': 'ABSENT_AFTER_SUCCESS'},
        'prismaDiff': {'name': 'personal-max-stage8b2a-prisma-diff-runner', 'cleanupState': 'ABSENT_AFTER_SUCCESS'},
        'allOwnedRunnersAbsent': True,
    }:
        return False
    production = evidence['production']
    if not exact_keys(production, {'containerHashBefore', 'containerHashAfter', 'restartCountsUnchanged', 'gitUnchanged'}):
        return False
    if not sha256(production['containerHashBefore']) or production['containerHashAfter'] != production['containerHashBefore'] or production['restartCountsUnchanged'] is not True or production['gitUnchanged'] is not True:
        return False
    storage = evidence['storage']
    if not exact_keys(storage, {'freeBytesBefore', 'freeBytesAfter', 'rollbackReserveBytes'}):
        return False
    if not nonnegative_integer(storage['freeBytesBefore']) or not nonnegative_integer(storage['freeBytesAfter']) or storage['rollbackReserveBytes'] != ROLLBACK_RESERVE_BYTES or storage['freeBytesAfter'] < ROLLBACK_RESERVE_BYTES:
        return False
    return evidence['safety'] == EXACT_MIGRATION_SAFETY


def valid_dormant_evidence(binding, migration_binding):
    if not exact_keys(binding, {'sha256', 'evidence'}) or not sha256(binding['sha256']):
        return False
    evidence = binding['evidence']
    if not exact_keys(evidence, {'schemaVersion', 'mode', 'script', 'bindings', 'acceptedMigration', 'image', 'runtime', 'behavior', 'production', 'storage', 'rollback'}):
        return False
    if evidence['schemaVersion'] != 1 or evidence['mode'] != 'DORMANT_GATEWAY_ROLLOUT':
        return False
    if evidence['script'] != {'sha256': EXPECTED_DORMANT_SCRIPT_SHA, 'checksumBound': True}:
        return False
    migration_evidence = migration_binding['evidence']
    if evidence['bindings'] != {
        'isolatedReportSha256': migration_evidence['bindings']['isolatedReportSha256'],
        'migrationReportSha256': migration_binding['sha256'],
        'migrationScriptSha256': EXPECTED_MIGRATION_SCRIPT_SHA,
    }:
        return False
    if evidence['acceptedMigration'] != {
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
        'acceptedLedgerOnlyMigrations': EXPECTED_LEDGER_ONLY,
    }:
        return False
    if evidence['image'] != {'ref': EXPECTED_GATEWAY_REF, 'runtimeUser': '1000:1000'}:
        return False
    if evidence['runtime'] != {
        'container': 'personal-max-dormant-gateway',
        'network': 'personal-max-stage8b2b-dormant',
        'networkInternal': True,
        'publicPorts': 0,
        'mounts': 0,
        'health': 'PASS',
        'readiness': 'dormant-ready',
        'restartPolicy': 'unless-stopped',
    }:
        return False
    if evidence['behavior'] != {
        'databaseConfigured': False,
        'databaseWrites': 0,
        'captureEnabled': False,
        'senderActive': False,
        'browserLaunched': False,
        'maxContacted': False,
        'providerAction': False,
    }:
        return False
    production = evidence['production']
    if not exact_keys(production, {'hashBefore', 'hashAfter', 'unchanged', 'restartCountsUnchanged'}):
        return False
    if not sha256(production['hashBefore']) or production['hashAfter'] != production['hashBefore'] or production['unchanged'] is not True or production['restartCountsUnchanged'] is not True:
        return False
    storage = evidence['storage']
    if not exact_keys(storage, {'freeBytesBefore'}) or not nonnegative_integer(storage['freeBytesBefore']) or storage['freeBytesBefore'] <= 0:
        return False
    return evidence['rollback'] == {
        'available': True,
        'automatic': False,
        'scriptSha256': EXPECTED_DORMANT_ROLLBACK_SHA,
        'composeSha256': EXPECTED_DORMANT_COMPOSE_SHA,
    }


def valid_projection_contract(contract, gateway):
    if not exact_keys(contract, {'value', 'factKind', 'runtimeObserved', 'sourceCommit', 'appliesToObservedGateway', 'files'}):
        return False
    files = contract['files']
    if not isinstance(files, list) or len(files) != len(EXPECTED_PROJECTION_FILES):
        return False
    observed = {}
    for item in files:
        if not exact_keys(item, {'path', 'sha256'}) or item['path'] in observed:
            return False
        observed[item['path']] = item['sha256']
    expected_applies = gateway['sourceRevision'] == EXPECTED_SOURCE_COMMIT
    return (
        contract['value'] is True
        and contract['factKind'] == 'SOURCE_BOUND_CONTRACT'
        and contract['runtimeObserved'] is False
        and contract['sourceCommit'] == EXPECTED_SOURCE_COMMIT
        and contract['appliesToObservedGateway'] is expected_applies
        and observed == EXPECTED_PROJECTION_FILES
    )


def valid_owner_fact(value, status):
    if value is None:
        return status == 'UNKNOWN_REQUIRES_SEPARATE_AUTHORIZED_RUNTIME_METADATA'
    return nonnegative_integer(value) and status == 'OBSERVED_EXACT_RUNTIME_METADATA'


def valid_scraper(scraper, target):
    dormant = target == 'dormant'
    common = {'requiredForTarget', 'observed', 'observationStatus', 'containerCount', 'containerState', 'dockerHealth', 'restartCount', 'startedAtEpoch', 'image', 'sourceRevision', 'profileMount', 'existingFlowHealthy'}
    if dormant:
        return exact_keys(scraper, common) and scraper == {
            'requiredForTarget': False, 'observed': False, 'observationStatus': 'NOT_IN_TARGET_SCOPE',
            'containerCount': None, 'containerState': None, 'dockerHealth': None,
            'restartCount': None, 'startedAtEpoch': None, 'image': None, 'sourceRevision': None,
            'profileMount': None, 'existingFlowHealthy': None,
        }
    if scraper.get('observed') is False:
        return exact_keys(scraper, common) and scraper == {
            'requiredForTarget': True, 'observed': False,
            'observationStatus': 'EXPECTED_EXACTLY_ONE_CONTAINER',
            'containerCount': scraper.get('containerCount'), 'containerState': None,
            'dockerHealth': None, 'restartCount': None, 'startedAtEpoch': None, 'image': None,
            'sourceRevision': None, 'profileMount': None, 'existingFlowHealthy': None,
        } and nonnegative_integer(scraper['containerCount']) and scraper['containerCount'] != 1
    if not exact_keys(scraper, common | {'containerId'}):
        return False
    profile = scraper['profileMount']
    return (
        scraper['requiredForTarget'] is True and scraper['observed'] is True
        and scraper['observationStatus'] == 'OBSERVED' and scraper['containerCount'] == 1
        and isinstance(scraper['containerId'], str) and HEX_64.fullmatch(scraper['containerId']) is not None
        and isinstance(scraper['containerState'], str) and isinstance(scraper['dockerHealth'], str)
        and nonnegative_integer(scraper['restartCount']) and nonnegative_integer(scraper['startedAtEpoch'])
        and valid_image(scraper['image'], EXPECTED_SCRAPER_REF)
        and isinstance(scraper['sourceRevision'], str) and HEX_40.fullmatch(scraper['sourceRevision']) is not None
        and exact_keys(profile, {'destination', 'exactCount', 'readWrite'})
        and profile['destination'] == '/app/user_data' and nonnegative_integer(profile['exactCount'])
        and isinstance(profile['readWrite'], bool)
        and (scraper['existingFlowHealthy'] is None or isinstance(scraper['existingFlowHealthy'], bool))
    )


def structurally_valid(report, target, final=False):
    if not isinstance(report, dict) or target not in TARGETS:
        return False
    expected_keys = BASE_KEYS | ({'evaluation'} if final else set())
    if set(report) != expected_keys or report.get('schemaVersion') != 2 or report.get('mode') != 'SHADOW_OBSERVATION' or report.get('target') != target:
        return False
    if not exact_keys(report['script'], {'sha256', 'checksumBound'}) or not sha256(report['script']['sha256']) or report['script']['checksumBound'] is not True:
        return False

    if not exact_keys(report['bindings'], {'migrationReport', 'dormantRolloutReport'}):
        return False
    migration_binding = report['bindings']['migrationReport']
    dormant_binding = report['bindings']['dormantRolloutReport']
    if not valid_migration_evidence(migration_binding) or not valid_dormant_evidence(dormant_binding, migration_binding):
        return False

    window = report['window']
    if not exact_keys(window, {'mode', 'startEpoch', 'endEpoch', 'seconds'}):
        return False
    if window['mode'] not in WINDOWS or window['seconds'] != WINDOWS[window['mode']]:
        return False
    if not nonnegative_integer(window['startEpoch']) or not nonnegative_integer(window['endEpoch']) or window['endEpoch'] - window['startEpoch'] != window['seconds']:
        return False

    database = report['database']
    if not exact_keys(database, {'schemaVersion', 'databaseSnapshotIdentity', 'window', 'accountCount', 'accounts', 'totals', 'activity', 'locks', 'schemaState'}):
        return False
    if database['schemaVersion'] != 2 or not isinstance(database['databaseSnapshotIdentity'], str) or not database['databaseSnapshotIdentity']:
        return False
    if database['window'] != {'startEpoch': window['startEpoch'], 'endEpoch': window['endEpoch'], 'seconds': window['seconds']}:
        return False
    accounts = database['accounts']
    cardinality = {'dormant': {0}, 'default-off': {1, 2}, 'one-account': {1}, 'ab': {2}}[target]
    if not isinstance(accounts, list) or database['accountCount'] != len(accounts) or len(accounts) not in cardinality:
        return False
    aliases = []
    for account in accounts:
        if not exact_keys(account, ACCOUNT_KEYS) or not isinstance(account['alias'], str) or HEX_64.fullmatch(account['alias']) is None:
            return False
        aliases.append(account['alias'])
        integer_fields = ACCOUNT_KEYS - {'alias', 'rawJournalRowsPerSecond', 'journalLatencyMs'}
        if any(not nonnegative_integer(account[key]) for key in integer_fields) or not nonnegative(account['rawJournalRowsPerSecond']):
            return False
        latency = account['journalLatencyMs']
        if not exact_keys(latency, {'p50', 'p95', 'p99'}) or any(not nonnegative(latency[key]) for key in ('p50', 'p95', 'p99')):
            return False
        if not latency['p50'] <= latency['p95'] <= latency['p99']:
            return False
        if (
            account['accidentalDuplicateEnvelopes'] > account['rawJournalRows']
            or account['rawQuarantined'] > account['rawJournalRows']
            or account['normalizationResults'] + account['unprocessedRows'] != account['rawJournalRows']
            or account['normalizationQuarantined'] + account['normalizationUnsupported'] > account['normalizationResults']
            or account['semanticRegressions'] > account['semanticComparisons']
            or account['criticalRegressions'] > account['semanticRegressions']
            or account['routeIdentityCritical'] > account['criticalDiffs']
            or (account['unprocessedRows'] == 0 and account['oldestUnprocessedSeconds'] != 0)
        ):
            return False
        if abs(account['rawJournalRowsPerSecond'] - round(account['rawJournalRows'] / window['seconds'], 6)) > 0.000001:
            return False
    if len(aliases) != len(set(aliases)):
        return False
    totals = database['totals']
    if not exact_keys(totals, {'rawJournalRows', 'rawJournalRowsPerSecond'}):
        return False
    if not nonnegative_integer(totals['rawJournalRows']) or not nonnegative(totals['rawJournalRowsPerSecond']):
        return False
    if totals['rawJournalRows'] != sum(item['rawJournalRows'] for item in accounts):
        return False
    if abs(totals['rawJournalRowsPerSecond'] - round(sum(item['rawJournalRowsPerSecond'] for item in accounts), 6)) > 0.000001:
        return False
    if not exact_keys(database['activity'], {'active_sessions', 'long_transactions'}) or any(not nonnegative_integer(database['activity'][key]) for key in ('active_sessions', 'long_transactions')):
        return False
    if not exact_keys(database['locks'], {'waiting_locks'}) or not nonnegative_integer(database['locks']['waiting_locks']):
        return False
    schema_state = database['schemaState']
    if not exact_keys(schema_state, {'migrationLedger', 'rawJournal'}):
        return False
    ledger = schema_state['migrationLedger']
    if (
        not exact_keys(ledger, {'total', 'finished', 'failed', 'appliedExpectedMigrations'})
        or any(not nonnegative_integer(ledger[key]) for key in ('total', 'finished', 'failed'))
        or not isinstance(ledger['appliedExpectedMigrations'], list)
        or ledger['appliedExpectedMigrations'] != sorted(set(ledger['appliedExpectedMigrations']))
        or any(not isinstance(name, str) for name in ledger['appliedExpectedMigrations'])
    ):
        return False
    raw_schema = schema_state['rawJournal']
    if (
        not exact_keys(raw_schema, {
            'relationKind', 'constraints', 'expectedConstraintDefinitionsExact',
            'appendOnlyTriggerPresent', 'appendOnlyContractExact',
        })
        or not isinstance(raw_schema['relationKind'], str)
        or not isinstance(raw_schema['constraints'], list)
        or raw_schema['constraints'] != sorted(set(raw_schema['constraints']))
        or any(not isinstance(name, str) for name in raw_schema['constraints'])
        or any(not isinstance(raw_schema[key], bool) for key in (
            'expectedConstraintDefinitionsExact', 'appendOnlyTriggerPresent', 'appendOnlyContractExact',
        ))
    ):
        return False

    runtime = report['runtime']
    if not exact_keys(runtime, {'gateway', 'scraper'}):
        return False
    gateway = runtime['gateway']
    if not exact_keys(gateway, {
        'containerId', 'containerState', 'dockerHealth', 'restartCount', 'image',
        'sourceRevision', 'lifecycle', 'startedAtEpoch', 'runtimeUser', 'restartPolicy',
        'publicPortBindings', 'mountCount', 'networkNames', 'expectedNetworkInternal',
        'composeIdentity', 'securityConfig', 'http',
    }):
        return False
    if not isinstance(gateway['containerId'], str) or HEX_64.fullmatch(gateway['containerId']) is None:
        return False
    if not isinstance(gateway['containerState'], str) or not isinstance(gateway['dockerHealth'], str) or not nonnegative_integer(gateway['restartCount']):
        return False
    if not valid_image(gateway['image'], EXPECTED_GATEWAY_REF) or not isinstance(gateway['sourceRevision'], str) or HEX_40.fullmatch(gateway['sourceRevision']) is None or gateway['lifecycle'] != 'checksum-bound-compose':
        return False
    if (
        not nonnegative_integer(gateway['startedAtEpoch'])
        or not isinstance(gateway['runtimeUser'], str)
        or not isinstance(gateway['restartPolicy'], str)
        or not nonnegative_integer(gateway['publicPortBindings'])
        or not nonnegative_integer(gateway['mountCount'])
        or not isinstance(gateway['networkNames'], list)
        or gateway['networkNames'] != sorted(set(gateway['networkNames']))
        or any(not isinstance(name, str) or not name for name in gateway['networkNames'])
        or (gateway['expectedNetworkInternal'] is not None and not isinstance(gateway['expectedNetworkInternal'], bool))
        or not exact_keys(gateway['composeIdentity'], {'project', 'service', 'stage', 'mode'})
        or any(not isinstance(value, str) for value in gateway['composeIdentity'].values())
        or not exact_keys(gateway['securityConfig'], {
            'readonlyRootfs', 'privileged', 'capDrop', 'capAdd', 'securityOpt', 'init', 'pidsLimit',
        })
        or not isinstance(gateway['securityConfig']['readonlyRootfs'], bool)
        or not isinstance(gateway['securityConfig']['privileged'], bool)
        or not isinstance(gateway['securityConfig']['init'], bool)
        or not nonnegative_integer(gateway['securityConfig']['pidsLimit'])
        or any(
            not isinstance(gateway['securityConfig'][key], list)
            or gateway['securityConfig'][key] != sorted(set(gateway['securityConfig'][key]))
            or any(not isinstance(item, str) for item in gateway['securityConfig'][key])
            for key in ('capDrop', 'capAdd', 'securityOpt')
        )
    ):
        return False
    http = gateway['http']
    if not exact_keys(http, {
        'healthStatus', 'mode', 'enabledAccountCount', 'enabledAccountAliases',
        'accountIdentityStatus', 'readinessStatus', 'readinessState',
        'senderModulesInactive', 'providerActionsInactive',
    }):
        return False
    if not nonnegative_integer(http['healthStatus']) or http['mode'] not in ('dormant', 'active') or not nonnegative_integer(http['enabledAccountCount']) or not nonnegative_integer(http['readinessStatus']) or http['readinessState'] not in ('dormant-ready', 'ready', 'not-ready') or not isinstance(http['senderModulesInactive'], bool) or not isinstance(http['providerActionsInactive'], bool):
        return False
    aliases = http['enabledAccountAliases']
    if aliases is None:
        if http['enabledAccountCount'] == 0 or http['accountIdentityStatus'] != 'UNKNOWN_RUNTIME_DOES_NOT_EXPOSE_HASHED_ACCOUNT_SCOPE':
            return False
    elif (
        not isinstance(aliases, list)
        or aliases != sorted(set(aliases))
        or len(aliases) != http['enabledAccountCount']
        or any(not sha256(alias) for alias in aliases)
        or http['accountIdentityStatus'] not in ('EMPTY_SCOPE_CONFIRMED', 'OBSERVED_HASHED_RUNTIME_ACCOUNT_SCOPE')
        or (not aliases and http['accountIdentityStatus'] != 'EMPTY_SCOPE_CONFIRMED')
        or (aliases and http['accountIdentityStatus'] != 'OBSERVED_HASHED_RUNTIME_ACCOUNT_SCOPE')
    ):
        return False
    if not valid_scraper(runtime['scraper'], target):
        return False

    release = report['release']
    if not exact_keys(release, {'expectedImageSourceCommit', 'gatewaySourceRevision', 'scraperSourceRevision'}):
        return False
    if release['expectedImageSourceCommit'] != EXPECTED_SOURCE_COMMIT or release['gatewaySourceRevision'] != gateway['sourceRevision'] or release['scraperSourceRevision'] != runtime['scraper']['sourceRevision']:
        return False

    counters = report['runtimeCounters']
    if not exact_keys(counters, COUNTER_KEYS) or counters['scope'] != 'gateway_process_lifetime':
        return False
    if any(counters[key] is not None and not nonnegative_integer(counters[key]) for key in REQUIRED_COUNTERS):
        return False
    metrics_complete = all(nonnegative_integer(counters[key]) for key in REQUIRED_COUNTERS)
    if counters['metricsComplete'] is not metrics_complete or not nonnegative_integer(counters['spoolLimitBytes']):
        return False
    if counters['spoolLimitEvidence'] not in ('NOT_REQUIRED_FOR_TARGET', 'OPERATOR_BOUND_NOT_RUNTIME_OBSERVED', 'SOURCE_BOUND_CONTRACT', 'RUNTIME_OBSERVED'):
        return False
    if target in ('dormant', 'default-off') and (counters['spoolLimitBytes'] != 0 or counters['spoolLimitEvidence'] != 'NOT_REQUIRED_FOR_TARGET'):
        return False

    ownership = report['ownership']
    if not exact_keys(ownership, {'browserOwnersObserved', 'browserOwnershipStatus', 'listenerOwnersObserved', 'listenerOwnershipStatus'}):
        return False
    if not valid_owner_fact(ownership['browserOwnersObserved'], ownership['browserOwnershipStatus']) or not valid_owner_fact(ownership['listenerOwnersObserved'], ownership['listenerOwnershipStatus']):
        return False

    observability = report['observability']
    if not exact_keys(observability, {'physicalFrames'}):
        return False
    frames = observability['physicalFrames']
    if not exact_keys(frames, {'count', 'status', 'rawJournalRowsAreNotPhysicalFrames'}) or frames['rawJournalRowsAreNotPhysicalFrames'] is not True:
        return False
    if frames['count'] is None:
        if frames['status'] != 'UNKNOWN_NO_WINDOW_ALIGNED_PHYSICAL_FRAME_SOURCE':
            return False
    elif not nonnegative_integer(frames['count']) or frames['status'] != 'OBSERVED_WINDOW_ALIGNED':
        return False

    disk = report['disk']
    if not exact_keys(disk, {'dockerRoot', 'freeBytes', 'rollbackReserveBytes', 'belowReserve'}):
        return False
    if not isinstance(disk['dockerRoot'], str) or not disk['dockerRoot'].startswith('/') or not nonnegative_integer(disk['freeBytes']) or disk['rollbackReserveBytes'] != ROLLBACK_RESERVE_BYTES:
        return False
    if disk['belowReserve'] is not (disk['freeBytes'] < disk['rollbackReserveBytes']):
        return False

    contracts = report['sourceContracts']
    if not exact_keys(contracts, {'projectionDisabled', 'senderDisabled', 'providerActionsInactive'}):
        return False
    if not valid_projection_contract(contracts['projectionDisabled'], gateway):
        return False
    if contracts['senderDisabled'] != {'value': http['senderModulesInactive'], 'runtimeReadinessObserved': True}:
        return False
    if contracts['providerActionsInactive'] != {'value': http['providerActionsInactive'], 'runtimeReadinessObserved': True}:
        return False

    recovery = report['recoveryEvidence']
    if not exact_keys(recovery, {'reconnectRecovery', 'restartRecovery', 'status'}):
        return False
    if recovery['status'] == 'NOT_EXECUTED_REQUIRES_SEPARATE_AUTHORIZATION':
        if recovery['reconnectRecovery'] is not None or recovery['restartRecovery'] is not None:
            return False
    elif recovery['status'] == 'OBSERVED_SEPARATELY_AUTHORIZED':
        if not isinstance(recovery['reconnectRecovery'], bool) or not isinstance(recovery['restartRecovery'], bool):
            return False
    else:
        return False

    if report['privacy'] != EXACT_PRIVACY or report['safety'] != EXACT_SAFETY:
        return False
    action = report['action']
    if not exact_keys(action, {'rollbackExecuted', 'enablementFrozen'}) or action['rollbackExecuted'] is not False or not isinstance(action['enablementFrozen'], bool):
        return False
    if not final and action['enablementFrozen'] is not False:
        return False
    return True


def _evaluate(report, target):
    if not structurally_valid(report, target):
        return malformed()
    accounts = report['database']['accounts']
    totals = report['database']['totals']
    counters = report['runtimeCounters']
    ownership = report['ownership']
    gateway = report['runtime']['gateway']
    scraper = report['runtime']['scraper']
    http = gateway['http']
    recovery = report['recoveryEvidence']
    triggers = []

    def add(condition, trigger):
        if condition:
            triggers.append(trigger)

    add(gateway['containerState'] != 'running', 'gateway_not_running')
    add(gateway['dockerHealth'] != 'healthy', 'gateway_docker_health_failure')
    add(http['healthStatus'] != 200, 'gateway_health_failure')
    add(gateway['sourceRevision'] != EXPECTED_SOURCE_COMMIT, 'gateway_source_revision_mismatch')
    add(gateway['restartCount'] != 0, 'repeated_restart')
    add(gateway['startedAtEpoch'] > report['window']['startEpoch'], 'gateway_started_after_window_start')
    add(gateway['runtimeUser'] != '1000:1000', 'gateway_runtime_user_mismatch')
    add(gateway['restartPolicy'] != 'unless-stopped', 'gateway_restart_policy_mismatch')
    add(gateway['publicPortBindings'] != 0, 'public_port_binding_detected')
    add(gateway['mountCount'] != 0, 'runtime_mount_detected')
    add(gateway['networkNames'] != [EXPECTED_DORMANT_NETWORK] or gateway['expectedNetworkInternal'] is not True, 'gateway_network_contract_mismatch')
    add(gateway['composeIdentity'] != EXPECTED_COMPOSE_IDENTITY, 'gateway_compose_identity_mismatch')
    add(gateway['securityConfig'] != {
        'readonlyRootfs': True,
        'privileged': False,
        'capDrop': ['ALL'],
        'capAdd': [],
        'securityOpt': ['no-new-privileges:true'],
        'init': True,
        'pidsLimit': 128,
    }, 'gateway_security_config_mismatch')
    add(counters['metricsComplete'] is not True, 'runtime_metrics_unknown')
    add(report['disk']['belowReserve'] is True, 'disk_below_reserve')
    add(report['database']['activity']['long_transactions'] > 0 or report['database']['locks']['waiting_locks'] > 0, 'database_pressure')
    schema_state = report['database']['schemaState']
    add(
        schema_state['migrationLedger'] != {
            'total': 54,
            'finished': 54,
            'failed': 0,
            'appliedExpectedMigrations': sorted(EXPECTED_MIGRATIONS),
        }
        or schema_state['rawJournal'] != {
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
        'current_schema_contract_mismatch',
    )
    add(report['sourceContracts']['projectionDisabled']['appliesToObservedGateway'] is not True, 'projection_contract_unproven')
    add(report['sourceContracts']['senderDisabled']['value'] is not True, 'sender_disablement_unproven')
    add(report['sourceContracts']['providerActionsInactive']['value'] is not True, 'provider_inactivity_unproven')
    if target == 'default-off':
        add(True, 'default_off_external_evidence_binding_missing')
    elif target in ('one-account', 'ab'):
        add(True, 'active_external_evidence_binding_missing')

    raw_rows = totals['rawJournalRows']
    raw_rate = totals['rawJournalRowsPerSecond']
    if target == 'dormant':
        add(raw_rows != 0, 'dormant_database_scope_mismatch')
        add(http['mode'] != 'dormant' or http['enabledAccountCount'] != 0, 'gateway_not_dormant')
        add(http['readinessStatus'] != 200 or http['readinessState'] != 'dormant-ready', 'gateway_readiness_failure')
        add(nonnegative(counters['captureAcceptedEnvelopes']) and counters['captureAcceptedEnvelopes'] != 0, 'unexpected_capture')
        add(nonnegative(counters['spoolPending']) and counters['spoolPending'] != 0, 'unexpected_spool')
    else:
        add(scraper['observed'] is not True or scraper['containerCount'] != 1, 'scraper_runtime_unproven')
        if scraper['observed'] is True:
            add(scraper['containerState'] != 'running' or scraper['dockerHealth'] != 'healthy', 'scraper_health_failure')
            add(scraper['sourceRevision'] != EXPECTED_SOURCE_COMMIT, 'scraper_source_revision_mismatch')
            add(scraper['restartCount'] != 0, 'scraper_restart_detected')
            add(scraper['startedAtEpoch'] > report['window']['startEpoch'], 'scraper_started_after_window_start')
            profile = scraper['profileMount']
            add(profile['exactCount'] != 1 or profile['readWrite'] is not True, 'profile_mount_contract_unproven')
        add(ownership['browserOwnersObserved'] != 1, 'browser_ownership_unproven')
        add(ownership['listenerOwnersObserved'] != 1, 'listener_ownership_unproven')

    if target == 'default-off':
        add(raw_rows != 0, 'default_off_journal_side_effect')
        add(http['mode'] != 'dormant' or http['enabledAccountCount'] != 0 or http['readinessStatus'] != 200 or http['readinessState'] != 'dormant-ready', 'gateway_readiness_failure')
        add(nonnegative(counters['captureAcceptedEnvelopes']) and counters['captureAcceptedEnvelopes'] != 0, 'default_off_capture_side_effect')
        add(nonnegative(counters['spoolPending']) and counters['spoolPending'] != 0, 'default_off_spool_side_effect')
        add(scraper.get('existingFlowHealthy') is not True, 'existing_flow_health_unproven')
    elif target in ('one-account', 'ab'):
        expected_accounts = 1 if target == 'one-account' else 2
        add(http['mode'] != 'active' or http['enabledAccountCount'] != expected_accounts, 'gateway_account_scope_mismatch')
        add(
            http['accountIdentityStatus'] != 'OBSERVED_HASHED_RUNTIME_ACCOUNT_SCOPE'
            or http['enabledAccountAliases'] is None
            or sorted(http['enabledAccountAliases']) != sorted(account['alias'] for account in accounts),
            'gateway_account_identity_unproven',
        )
        add(http['readinessStatus'] != 200 or http['readinessState'] != 'ready', 'gateway_readiness_failure')
        add(raw_rows <= 0 or raw_rate <= 0 or any(account['rawJournalRows'] <= 0 or account['rawJournalRowsPerSecond'] <= 0 for account in accounts), 'raw_journal_ingestion_stopped')
        add(not nonnegative_integer(counters['captureAcceptedEnvelopes']) or counters['captureAcceptedEnvelopes'] < raw_rows, 'capture_counter_inconsistent')
        add(sum(account['accidentalDuplicateEnvelopes'] for account in accounts) > 0, 'accidental_duplicate')
        add(nonnegative(counters['wrongAccount']) and counters['wrongAccount'] > 0, 'wrong_account')
        add(max(sum(account['criticalRegressions'] for account in accounts), counters['criticalRegressions'] if nonnegative(counters['criticalRegressions']) else 0) > 0, 'critical_semantic_regression')
        add(sum(account['criticalDiffs'] for account in accounts) > 0, 'critical_semantic_regression')
        add(sum(account['routeIdentityCritical'] for account in accounts) > 0, 'critical_semantic_regression')
        add(sum(account['openRouteConflicts'] for account in accounts) > 0, 'route_conflict')
        add(nonnegative(counters['lostBeforeSpool']) and counters['lostBeforeSpool'] > 0, 'lost_before_spool')
        add(nonnegative(counters['drainFailures']) and counters['drainFailures'] > 0, 'journal_ingestion_failure')
        add(sum(account['semanticComparisons'] for account in accounts) <= 0, 'semantic_comparison_stopped')
        frame_fact = report['observability']['physicalFrames']
        add(frame_fact['status'] != 'OBSERVED_WINDOW_ALIGNED' or not nonnegative_integer(frame_fact['count']) or frame_fact['count'] <= 0, 'physical_frame_observability_unproven')
        limit = counters['spoolLimitBytes']
        add(limit < 1 or counters['spoolLimitEvidence'] not in ('SOURCE_BOUND_CONTRACT', 'RUNTIME_OBSERVED'), 'spool_limit_unknown')
        if limit >= 1 and nonnegative(counters['spoolBytes']):
            add(counters['spoolBytes'] >= limit * 0.7, 'spool_threshold')
        if all(nonnegative_integer(counters[key]) for key in ('spoolPending', 'spoolBytes', 'oldestSpoolAgeMs')):
            add(
                (counters['spoolPending'] == 0 and (counters['spoolBytes'] != 0 or counters['oldestSpoolAgeMs'] != 0))
                or (counters['spoolPending'] > 0 and (counters['spoolBytes'] < counters['spoolPending'] or counters['oldestSpoolAgeMs'] == 0)),
                'spool_metrics_inconsistent',
            )
            add(
                counters['spoolPending'] > 0 and counters['oldestSpoolAgeMs'] >= report['window']['seconds'] * 1000,
                'spool_age_threshold',
            )
        add(recovery['reconnectRecovery'] is not True, 'reconnect_recovery_unproven')
        add(recovery['restartRecovery'] is not True, 'restart_recovery_unproven')

    triggers = sorted(set(triggers))
    return {
        'verdict': 'ACCEPT' if not triggers else 'FREEZE_ENABLEMENT',
        'freezeEnablement': bool(triggers),
        'triggers': triggers,
        'recommendedAction': 'CONTINUE_AUTHORIZED_OBSERVATION' if not triggers else 'REVIEW_EXACT_TRIGGERS_AND_AUTHORIZE_NEXT_BOUNDED_ACTION',
        'rollbackExecuted': False,
    }


def evaluate(report, target):
    try:
        return _evaluate(report, target)
    except Exception:
        return malformed()


def validate_final_report(report, target):
    try:
        if not structurally_valid(report, target, final=True):
            return False
        evaluation = report['evaluation']
        if not exact_keys(evaluation, {'verdict', 'freezeEnablement', 'triggers', 'recommendedAction', 'rollbackExecuted'}):
            return False
        base = copy.deepcopy(report)
        del base['evaluation']
        base['action']['enablementFrozen'] = False
        expected = evaluate(base, target)
        return evaluation == expected and report['action'] == {'rollbackExecuted': False, 'enablementFrozen': expected['freezeEnablement']}
    except Exception:
        return False


def load(path):
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--validate-final':
        valid = validate_final_report(load(sys.argv[2]), sys.argv[3])
        print(json.dumps({'valid': valid}, separators=(',', ':')))
        sys.exit(0 if valid else 3)
    if len(sys.argv) != 3:
        print(json.dumps(malformed(), separators=(',', ':')))
        sys.exit(2)
    try:
        result = evaluate(load(sys.argv[1]), sys.argv[2])
        print(json.dumps(result, separators=(',', ':')))
        if result['verdict'] == 'MALFORMED_REPORT':
            sys.exit(2)
    except Exception:
        print(json.dumps(malformed(), separators=(',', ':')))
        sys.exit(2)
