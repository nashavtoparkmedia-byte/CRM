# Pre-seal status

Runtime `2.0.0-19` coordinated Gravity + MAX builder is source-only and does
not itself authorize installation or production activation.

Required before installation:

1. fresh exact production snapshot and predecessor equality;
2. deterministic package and bootstrap outputs;
3. complete bounded tests for privilege, artifact admission, pair transitions,
   mixed/unknown recovery, rollback, volume preservation, and DB non-mutation;
4. independent architecture, security, reliability, diff, MAX build-semantic,
   and Runtime reviews with no residual HIGH/MEDIUM finding;
5. exact release seal and bootstrap identity.

The accepted MAX application behavior and Contact/CNT1 ownership are outside
this builder and must remain byte-identical to accepted application commit
`fb9fb30d9eb221a04342fe0ef7324f78d8ff7576`.
