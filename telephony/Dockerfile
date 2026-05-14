# Base safarov image's entrypoint does:
#   cp -varf /usr/share/freeswitch/conf/vanilla/* /etc/freeswitch/
# on first start. By baking our overrides into the vanilla dir at build time,
# that copy step puts OUR files in /etc/freeswitch instead of stock examples.
# No volume mounts needed at runtime → no read-only-mount conflicts.

FROM safarov/freeswitch:latest

COPY ./conf/vars.xml /usr/share/freeswitch/conf/vanilla/vars.xml
COPY ./conf/sip_profiles/internal.xml /usr/share/freeswitch/conf/vanilla/sip_profiles/internal.xml
COPY ./conf/sip_profiles/external/megafon.xml /usr/share/freeswitch/conf/vanilla/sip_profiles/external/megafon.xml
COPY ./conf/directory/default/101.xml /usr/share/freeswitch/conf/vanilla/directory/default/101.xml
COPY ./conf/directory/default/102.xml /usr/share/freeswitch/conf/vanilla/directory/default/102.xml
COPY ./conf/dialplan/default/01_megafon_outbound.xml /usr/share/freeswitch/conf/vanilla/dialplan/default/01_megafon_outbound.xml
COPY ./conf/dialplan/default/02_megafon_inbound.xml /usr/share/freeswitch/conf/vanilla/dialplan/default/02_megafon_inbound.xml
COPY ./conf/dialplan/default/03_user_outbound.xml /usr/share/freeswitch/conf/vanilla/dialplan/default/03_user_outbound.xml
COPY ./conf/autoload_configs/event_socket.conf.xml /usr/share/freeswitch/conf/vanilla/autoload_configs/event_socket.conf.xml
COPY ./conf/autoload_configs/acl.conf.xml /usr/share/freeswitch/conf/vanilla/autoload_configs/acl.conf.xml
