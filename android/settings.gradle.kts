// YOKO CRM Android shell — Stage 1 (ANDROID_SHELL_SESSION_DEEPLINK_FOUNDATION).
//
// This Gradle build is deliberately standalone: it is NOT wired into the
// gravity-mvp npm build, and nothing in the CRM build depends on it. The shell
// renders the already-deployed CRM Messenger over HTTPS; it ships no CRM code.
pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "yoko-crm-shell"
include(":app")
