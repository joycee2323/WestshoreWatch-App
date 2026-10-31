/* Generate relay-format test vectors for the Westshore Watch app from the REAL
 * firmware code at tag x1m1-1.4-westshore:
 *   - 1.4 relay:  WSW-Firmware/main/odid_decoder.c + odid_encoder.c
 *   - 1.3 relay:  tests/odid_location/legacy_1_3 (cddc1df verbatim)
 *   - drone side: opendroneid-core-c encoder/decoder (tests/third_party)
 * Output, one case per line (semicolon separated, "-" = unknown/null):
 *   name;legacyPack77hex;rf2Pack102hex;droneLoc25hex;specHeading;specSpeed;status;height;lat;lon
 * specHeading/specSpeed are the opendroneid reference decode of the drone's
 * Location (what a spec decoder must produce); lat/lon/height/status likewise. */
#include <math.h>
#include <stdio.h>
#include <string.h>
#include "opendroneid.h"
#include "odid_decoder.h"
#include "odid_encoder.h"
#include "legacy_1_3/legacy_1_3.h"

static uint32_t st = 0xA5A5F00Du;
static uint32_t rng(void) { st = st * 1664525u + 1013904223u; return st; }
static double urand(double lo, double hi) { return lo + (hi - lo) * (rng() / 4294967296.0); }

static void hex(const uint8_t *b, int n) { for (int i = 0; i < n; i++) printf("%02x", b[i]); }

static void emit(const char *name, ODID_Location_data *L, const char *uas)
{
    ODID_BasicID_data bd; odid_initBasicIDData(&bd);
    bd.IDType = ODID_IDTYPE_SERIAL_NUMBER; bd.UAType = ODID_UATYPE_HELICOPTER_OR_MULTIROTOR;
    snprintf(bd.UASID, sizeof bd.UASID, "%s", uas);
    ODID_System_data sd; odid_initSystemData(&sd);
    sd.OperatorLatitude = L->Latitude + 0.001; sd.OperatorLongitude = L->Longitude - 0.001;
    sd.AreaCount = 1; sd.OperatorAltitudeGeo = 180.0f;
    uint8_t basic[25], loc[25], sys[25];
    if (encodeBasicIDMessage((ODID_BasicID_encoded *)basic, &bd) != ODID_SUCCESS) return;
    if (encodeLocationMessage((ODID_Location_encoded *)loc, L) != ODID_SUCCESS) return;
    if (encodeSystemMessage((ODID_System_encoded *)sys, &sd) != ODID_SUCCESS) return;

    uint8_t old_pack[77], old_h0[25];
    legacy13_relay(basic, loc, sys, old_pack, old_h0);

    odid_detection_t d; memset(&d, 0, sizeof d);
    odid_parse_message(basic, 25, &d);
    odid_parse_message(loc, 25, &d);
    odid_parse_message(sys, 25, &d);
    uint8_t new_sys[25], new_pack[WSD_PACK_PAYLOAD];
    odid_encode_system(&d.system, new_sys);
    odid_build_relay_pack(basic, &d.location, new_sys, new_pack);

    ODID_Location_data r; odid_initLocationData(&r);
    decodeLocationMessage(&r, (ODID_Location_encoded *)loc);

    printf("%s;", name); hex(old_pack, 77); printf(";"); hex(new_pack, WSD_PACK_PAYLOAD); printf(";"); hex(loc, 25);
    if (r.Direction > 360.5f) printf(";-"); else printf(";%.1f", r.Direction);
    if (r.SpeedHorizontal > 254.5f) printf(";-"); else printf(";%.2f", r.SpeedHorizontal);
    printf(";%d;%.1f;%.7f;%.7f\n", (int)r.Status, r.Height, r.Latitude, r.Longitude);
}

static ODID_Location_data base(int status, float dir, float speed)
{
    ODID_Location_data L; odid_initLocationData(&L);
    L.Status = (ODID_status_t)status; L.Direction = dir; L.SpeedHorizontal = speed;
    L.SpeedVertical = 0.0f; L.Latitude = 41.4611922; L.Longitude = -81.9237012;
    L.AltitudeBaro = 177.5f; L.AltitudeGeo = 179.0f; L.Height = 12.5f; L.TimeStamp = 360.0f;
    return L;
}

int main(void)
{
    ODID_Location_data L;
    L = base(1, 0.0f, 0.0f); L.Height = -1.0f;        emit("docked_status1_dir0_spd0", &L, "1668BR40FA0098ER");
    L = base(2, 271.0f, 10.0f);                         emit("airborne_dir271_spd10", &L, "VEC0000000000001");
    L = base(2, 90.0f, 10.0f);                          emit("airborne_dir90_spd10", &L, "VEC0000000000002");
    L = base(2, 135.0f, 21.5f);                         emit("airborne_dir135_spd21_5", &L, "VEC0000000000003");
    L = base(2, 45.0f, 100.0f);                         emit("airborne_dir45_spd100_mult", &L, "VEC0000000000004");
    L = base(2, 361.0f, 255.0f);                        emit("unknown_dir_and_speed", &L, "VEC0000000000005");
    L = base(4, 200.0f, 5.0f);                          emit("status4_rid_failure", &L, "VEC0000000000006");
    L = base(5, 10.0f, 1.0f);                           emit("status5_reserved", &L, "VEC0000000000007");
    L = base(0, 359.0f, 63.75f);                        emit("undeclared_dir359_spd63_75", &L, "VEC0000000000008");
    L = base(3, 1.0f, 64.5f);                           emit("emergency_dir1_spd64_5", &L, "VEC0000000000009");
    for (int i = 0; i < 300; i++) {
        L = base((int)(rng() % 6), (rng() % 25 == 0) ? 361.0f : (float)(rng() % 360), 0);
        int sp = (int)(rng() % 20);
        L.SpeedHorizontal = sp == 0 ? 255.0f : sp < 4 ? (float)urand(63.76, 254.25) : (float)urand(0, 63.75);
        L.SpeedVertical = (float)urand(-30, 30);
        L.Latitude = urand(-89, 89); L.Longitude = urand(-179, 179);
        L.AltitudeGeo = (float)urand(-500, 3000); L.AltitudeBaro = L.AltitudeGeo;
        L.Height = (float)urand(-10, 500);
        L.HeightType = (ODID_Height_reference_t)(rng() % 2);
        char name[32], uas[21]; snprintf(name, sizeof name, "random_%03d", i); snprintf(uas, sizeof uas, "RND%013d", i);
        emit(name, &L, uas);
    }
    return 0;
}
