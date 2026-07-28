# Rollback contract — blocked with recreation

Rollback must restore exact previous image ID/digest, workdir, entrypoint, command, environment binding, mount, network, health, restart policy, labels and dependency behavior without copying or changing ownership of the profile. Those facts are not all currently observable, so an executable rollback would be unsafe. There is no prune, profile restore, parallel browser, or automatic rollback in this evidence package.
