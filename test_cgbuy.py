#!/usr/bin/env python3
"""
Unit tests for the pure logic in cgbuy, journal.py, eddn.py and plot.py.

Run with:  python3 test_cgbuy.py

No network, no tkinter window, no real Elite journal directory and no real
user config: every path the tests touch is a tempfile, and XDG_CONFIG_HOME is
redirected before cgbuy is imported so its CONFIG_PATH/STATE_PATH constants
can never point at the commander's own files.
"""

import atexit
import importlib.machinery
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))

# cgbuy does `try: import journal / plot / eddn`, so the project directory has
# to be importable before it is loaded.
if PROJECT_DIR not in sys.path:
    sys.path.insert(0, PROJECT_DIR)

# Redirect the config/state paths before cgbuy computes them at import time.
_CONFIG_SANDBOX = tempfile.mkdtemp(prefix="cgbuy-test-config-")
os.environ["XDG_CONFIG_HOME"] = _CONFIG_SANDBOX
atexit.register(shutil.rmtree, _CONFIG_SANDBOX, True)

import eddn                                                   # noqa: E402
import journal                                                # noqa: E402
import plot                                                   # noqa: E402

# cgbuy has no .py extension, so the normal import machinery cannot see it.
# Importing it only defines things; main() runs under __name__ == "__main__",
# which this is not, so no Tk root is ever created.
_loader = importlib.machinery.SourceFileLoader(
    "cgbuy", os.path.join(PROJECT_DIR, "cgbuy"))
_spec = importlib.util.spec_from_loader("cgbuy", _loader)
cgbuy = importlib.util.module_from_spec(_spec)
sys.modules["cgbuy"] = cgbuy
_loader.exec_module(cgbuy)


def ts(hh, mm, ss=0, day=1):
    """A journal timestamp on a fixed, DST-free winter day."""
    return "2025-01-%02dT%02d:%02d:%02dZ" % (day, hh, mm, ss)


# --------------------------------------------------------------------------
# eddn.norm_name
# --------------------------------------------------------------------------

class TestNormName(unittest.TestCase):

    def test_game_symbol_is_reduced_to_bare_name(self):
        self.assertEqual(eddn.norm_name("$gold_name;"), "gold")

    def test_case_and_whitespace_are_normalised(self):
        self.assertEqual(eddn.norm_name("  $Gold_Name;  "), "gold")

    def test_plain_names_pass_through(self):
        self.assertEqual(eddn.norm_name("gold"), "gold")
        self.assertEqual(eddn.norm_name("Bertrandite"), "bertrandite")

    def test_partial_decoration_is_handled(self):
        self.assertEqual(eddn.norm_name("$gold"), "gold")
        self.assertEqual(eddn.norm_name("gold;"), "gold")
        self.assertEqual(eddn.norm_name("gold_name"), "gold")

    def test_category_symbol(self):
        self.assertEqual(
            eddn.norm_name("$MARKET_category_Metals;"), "market_category_metals")

    def test_empty_and_none_are_safe(self):
        self.assertEqual(eddn.norm_name(""), "")
        self.assertEqual(eddn.norm_name(None), "")
        self.assertEqual(eddn.norm_name("   "), "")

    def test_embedded_underscore_name_is_not_stripped(self):
        # only a trailing _name is decoration
        self.assertEqual(eddn.norm_name("wine_names"), "wine_names")


# --------------------------------------------------------------------------
# eddn.build_message / eddn.validate
# --------------------------------------------------------------------------

def fake_market():
    """A miniature Market.json: two real goods, limpets, and a salvage item."""
    return {
        "timestamp": "2025-01-01T12:00:00Z",
        "event": "Market",
        "MarketID": 3223343616,
        "StationName": "Metz Enterprise",
        "StarSystem": "Ega",
        "StationType": "Coriolis",
        "Items": [
            {"id": 128049153, "Name": "$gold_name;",
             "Name_Localised": "Gold",
             "Category": "$MARKET_category_Metals;",
             "BuyPrice": 9000, "SellPrice": 9500, "MeanPrice": 9400,
             "StockBracket": 2, "DemandBracket": 3,
             "Stock": 1200, "Demand": 4000, "Consumer": True, "Producer": False,
             "Rare": False},
            {"id": 128049204, "Name": "$palladium_name;",
             "Category": "$MARKET_category_Metals;",
             "BuyPrice": 0, "SellPrice": 13800, "MeanPrice": 13300,
             "StockBracket": 0, "DemandBracket": 3,
             "Stock": 0, "Demand": 9000, "Rare": False},
            {"id": 128049519, "Name": "$drones_name;",
             "Category": "$MARKET_category_Utility;",
             "BuyPrice": 101, "SellPrice": 100, "MeanPrice": 101,
             "StockBracket": 3, "DemandBracket": 0,
             "Stock": 1000000, "Demand": 0, "Rare": False},
            {"id": 128667728, "Name": "$usscargoblackbox_name;",
             "Category": "$MARKET_category_NonMarketable;",
             "BuyPrice": 0, "SellPrice": 5000, "MeanPrice": 0,
             "StockBracket": 0, "DemandBracket": 1,
             "Stock": 0, "Demand": 1, "Rare": False},
        ],
    }


class TestBuildMessage(unittest.TestCase):

    def setUp(self):
        self.env = eddn.build_message(fake_market(), "TestCmdr", True, False)
        self.msg = self.env["message"]
        self.names = [c["name"] for c in self.msg["commodities"]]

    def test_envelope_shape(self):
        self.assertEqual(self.env["$schemaRef"], eddn.SCHEMA)
        self.assertEqual(self.env["header"]["uploaderID"], "TestCmdr")
        self.assertEqual(self.env["header"]["softwareName"], eddn.SOFTWARE)
        self.assertTrue(self.env["header"]["softwareVersion"])

    def test_required_message_keys_present(self):
        self.assertTrue(eddn.REQUIRED_MESSAGE_KEYS <= set(self.msg))
        self.assertEqual(self.msg["systemName"], "Ega")
        self.assertEqual(self.msg["stationName"], "Metz Enterprise")
        self.assertEqual(self.msg["marketId"], 3223343616)
        self.assertEqual(self.msg["timestamp"], "2025-01-01T12:00:00Z")
        self.assertEqual(self.msg["stationType"], "Coriolis")
        self.assertIs(self.msg["horizons"], True)
        self.assertIs(self.msg["odyssey"], False)

    def test_limpets_are_excluded(self):
        self.assertNotIn("drones", self.names)

    def test_nonmarketable_category_is_excluded(self):
        self.assertNotIn("usscargoblackbox", self.names)

    def test_normal_commodities_survive(self):
        self.assertEqual(self.names, ["gold", "palladium"])

    def test_zero_stock_entry_is_kept_for_its_sell_side(self):
        pal = self.msg["commodities"][1]
        self.assertEqual(pal["stock"], 0)
        self.assertEqual(pal["demand"], 9000)

    def test_commodity_fields_are_ints_and_declared(self):
        gold = self.msg["commodities"][0]
        self.assertTrue(eddn.REQUIRED_COMMODITY_KEYS <= set(gold))
        self.assertTrue(set(gold) <= eddn.ALLOWED_COMMODITY_KEYS)
        for k in ("meanPrice", "buyPrice", "stock", "sellPrice", "demand"):
            self.assertIsInstance(gold[k], int, k)
        self.assertEqual(gold["buyPrice"], 9000)
        self.assertEqual(gold["sellPrice"], 9500)
        self.assertEqual(gold["stock"], 1200)

    def test_non_rare_items_get_no_status_flags(self):
        self.assertNotIn("statusFlags", self.msg["commodities"][0])

    def test_rare_items_are_flagged(self):
        m = fake_market()
        m["Items"][0]["Rare"] = True
        env = eddn.build_message(m, "TestCmdr", True, True)
        self.assertEqual(env["message"]["commodities"][0]["statusFlags"],
                         ["Rare"])

    def test_optional_flags_omitted_when_unknown(self):
        env = eddn.build_message(fake_market(), "TestCmdr", None, None)
        self.assertNotIn("horizons", env["message"])
        self.assertNotIn("odyssey", env["message"])

    def test_missing_commander_falls_back(self):
        env = eddn.build_message(fake_market(), "", None, None)
        self.assertEqual(env["header"]["uploaderID"], "unknown")

    def test_validate_passes(self):
        self.assertEqual(eddn.validate(self.env), [])

    def test_validate_passes_with_gameversion(self):
        env = eddn.add_gameversion(self.env, "4.4.1.1", "r332841/r0")
        self.assertEqual(env["header"]["gameversion"], "4.4.1.1")
        self.assertEqual(env["header"]["gamebuild"], "r332841/r0")
        self.assertEqual(eddn.validate(env), [])

    def test_json_round_trip_still_validates(self):
        again = json.loads(json.dumps(self.env))
        self.assertEqual(eddn.validate(again), [])


class TestValidateCatchesProblems(unittest.TestCase):
    """validate() exists because the schema sets additionalProperties=false."""

    def env(self):
        return eddn.build_message(fake_market(), "TestCmdr", True, True)

    def test_undeclared_message_key_is_caught(self):
        env = self.env()
        env["message"]["Items"] = []          # a raw Market.json key leaking in
        problems = eddn.validate(env)
        self.assertTrue(problems)
        self.assertTrue(any("undeclared" in p and "Items" in p
                            for p in problems), problems)

    def test_undeclared_commodity_key_is_caught(self):
        env = self.env()
        env["message"]["commodities"][0]["Name_Localised"] = "Gold"
        problems = eddn.validate(env)
        self.assertTrue(any("commodity 0 undeclared" in p for p in problems),
                        problems)

    def test_missing_message_key_is_caught(self):
        env = self.env()
        del env["message"]["marketId"]
        self.assertTrue(any("missing" in p and "marketId" in p
                            for p in eddn.validate(env)))

    def test_missing_commodity_key_is_caught(self):
        env = self.env()
        del env["message"]["commodities"][0]["meanPrice"]
        self.assertTrue(any("commodity 0 missing" in p
                            for p in eddn.validate(env)))

    def test_missing_header_field_is_caught(self):
        env = self.env()
        env["header"]["uploaderID"] = ""
        self.assertTrue(any("uploaderID" in p for p in eddn.validate(env)))

    def test_non_integer_price_is_caught(self):
        env = self.env()
        env["message"]["commodities"][0]["buyPrice"] = 9000.5
        self.assertTrue(any("buyPrice" in p for p in eddn.validate(env)))

    def test_empty_commodity_list_is_caught(self):
        m = fake_market()
        m["Items"] = [i for i in m["Items"]
                      if "drones" in i["Name"] or "NonMarketable" in i["Category"]]
        env = eddn.build_message(m, "TestCmdr", True, True)
        self.assertEqual(env["message"]["commodities"], [])
        self.assertIn("no commodities", eddn.validate(env))


# --------------------------------------------------------------------------
# journal.Calibration
# --------------------------------------------------------------------------

class TestCalibration(unittest.TestCase):

    def test_empty_calibration_has_no_learned_values(self):
        cal = journal.Calibration()
        self.assertIsNone(cal.jump_minutes)
        self.assertIsNone(cal.dock_minutes)
        self.assertIsNone(cal.sc_scale)
        self.assertIn("estimate", cal.summary())

    def test_below_min_samples_returns_none(self):
        n = journal.Calibration.MIN_SAMPLES
        cal = journal.Calibration({"jump_secs": [60.0] * (n - 1),
                                   "dock_secs": [300.0] * (n - 1)})
        self.assertIsNone(cal.jump_minutes)
        self.assertIsNone(cal.dock_minutes)

    def test_at_min_samples_returns_median(self):
        n = journal.Calibration.MIN_SAMPLES
        self.assertEqual(n, 3)
        cal = journal.Calibration({"jump_secs": [30.0, 60.0, 900.0],
                                   "dock_secs": [120.0, 300.0, 600.0]})
        self.assertAlmostEqual(cal.jump_minutes, 1.0)       # median 60s
        self.assertAlmostEqual(cal.dock_minutes, 5.0)       # median 300s
        self.assertIn("jump 1.00 min (n=3)", cal.summary())

    def test_median_ignores_a_single_outlier(self):
        cal = journal.Calibration({"jump_secs": [60.0, 60.0, 60.0, 60.0, 290.0]})
        self.assertAlmostEqual(cal.jump_minutes, 1.0)

    def test_legacy_sc_samples_are_discarded(self):
        """Old configs hold sc_samples that paired a supercruise duration with
        an unrelated station's distance. They must not be loaded or trusted."""
        ls = 1000
        model = journal.est_sc_minutes(ls) * 60.0
        cal = journal.Calibration({"sc_samples": [(ls, model * 2.0)] * 3})
        self.assertEqual(cal.sc_samples, [])
        self.assertIsNone(cal.sc_scale)
        self.assertNotIn("sc_samples", cal.to_dict())

    def test_sc_scale_uses_approach_samples(self):
        ls = 1000
        model = journal.est_sc_minutes(ls) * 60.0
        cal = journal.Calibration({
            "approach_samples": [(ls, model * 1.5)] * 4,
        })
        self.assertAlmostEqual(cal.sc_scale, 1.5)

    def test_sc_scale_always_uses_approach_samples(self):
        """approach_samples is the only correctly-paired pool: FSDJump->Docked
        with that station's own DistFromStarLS."""
        ls = 1000
        model = journal.est_sc_minutes(ls) * 60.0
        cal = journal.Calibration({
            "sc_samples": [(ls, model * 3.0)] * 3,      # must be ignored
            "approach_samples": [(ls, model * 1.0)] * 50,
        })
        self.assertAlmostEqual(cal.sc_scale, 1.0)

    def test_sc_scale_none_when_both_pools_short(self):
        cal = journal.Calibration({"sc_samples": [(100, 60.0)],
                                   "approach_samples": [(100, 60.0)]})
        self.assertIsNone(cal.sc_scale)

    def test_samples_are_capped_at_200(self):
        cal = journal.Calibration({"jump_secs": list(range(500))})
        self.assertEqual(len(cal.jump_secs), 200)
        self.assertEqual(cal.jump_secs[0], 300)

    def test_to_dict_round_trip_through_constructor(self):
        src = journal.Calibration({
            "jump_secs": [40.0, 50.0, 60.0],
            "dock_secs": [200.0, 250.0, 300.0],
            "sc_samples": [(500, 90.0), (1000, 120.0), (2000, 150.0)],
            "approach_samples": [(500, 130.0), (1000, 160.0), (2000, 200.0)],
        })
        again = journal.Calibration(src.to_dict())
        self.assertEqual(again.to_dict(), src.to_dict())
        self.assertEqual(again.jump_minutes, src.jump_minutes)
        self.assertEqual(again.dock_minutes, src.dock_minutes)
        self.assertEqual(again.sc_scale, src.sc_scale)

    def test_round_trip_through_json(self):
        """The config file is JSON, so tuples come back as lists."""
        src = journal.Calibration({
            "jump_secs": [40.0, 50.0, 60.0],
            "sc_samples": [(500, 90.0), (1000, 120.0), (2000, 150.0)],
        })
        again = journal.Calibration(json.loads(json.dumps(src.to_dict())))
        self.assertEqual(again.sc_samples, src.sc_samples)
        self.assertTrue(all(isinstance(x, tuple) for x in again.sc_samples))
        self.assertAlmostEqual(again.sc_scale, src.sc_scale)

    def test_constructor_tolerates_empty_and_missing(self):
        self.assertEqual(journal.Calibration(None).to_dict(),
                         journal.Calibration({}).to_dict())


class TestParseTs(unittest.TestCase):

    def test_parses_zulu_timestamps(self):
        a = journal.parse_ts(ts(12, 0, 0))
        b = journal.parse_ts(ts(12, 1, 0))
        self.assertIsNotNone(a)
        self.assertAlmostEqual(b - a, 60.0)

    def test_bad_input_is_none(self):
        self.assertIsNone(journal.parse_ts(None))
        self.assertIsNone(journal.parse_ts(""))
        self.assertIsNone(journal.parse_ts("not a timestamp"))
        self.assertIsNone(journal.parse_ts(12345))


# --------------------------------------------------------------------------
# journal.JournalWatcher._handle
# --------------------------------------------------------------------------

class WatcherTestCase(unittest.TestCase):
    """A watcher pointed at an empty temp dir: never sees the real journals."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="cgbuy-test-journal-")
        self.addCleanup(self.tmp.cleanup)
        self.w = journal.JournalWatcher(directory=self.tmp.name)
        self.assertEqual(self.w.dir, self.tmp.name)

    def feed(self, *events):
        """Push synthetic journal lines through _handle. Returns learn flags."""
        return [self.w._handle(json.dumps(e) + "\n", live=False)
                for e in events]


class TestHandleJumps(WatcherTestCase):

    def test_back_to_back_jumps_make_a_sample(self):
        learned = self.feed(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "Sol"},
            {"timestamp": ts(12, 1, 0), "event": "FSDJump", "StarSystem": "Ega"},
        )
        self.assertEqual(learned, [False, True])
        self.assertEqual(self.w.cal.jump_secs, [60.0])
        self.assertEqual(self.w.system, "Ega")
        self.assertFalse(self.w.docked)

    def test_three_jumps_make_two_samples(self):
        self.feed(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "A"},
            {"timestamp": ts(12, 0, 40), "event": "FSDJump", "StarSystem": "B"},
            {"timestamp": ts(12, 1, 40), "event": "FSDJump", "StarSystem": "C"},
        )
        self.assertEqual(self.w.cal.jump_secs, [40.0, 60.0])

    def test_too_fast_interval_is_rejected(self):
        # under the 15s window - not a real route jump
        self.feed(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "A"},
            {"timestamp": ts(12, 0, 5), "event": "FSDJump", "StarSystem": "B"},
        )
        self.assertEqual(self.w.cal.jump_secs, [])

    def test_long_gap_is_rejected(self):
        # over the 300s window - you stopped to do something
        self.feed(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "A"},
            {"timestamp": ts(12, 30, 0), "event": "FSDJump", "StarSystem": "B"},
        )
        self.assertEqual(self.w.cal.jump_secs, [])

    def test_window_boundaries_are_inclusive(self):
        self.feed(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "A"},
            {"timestamp": ts(12, 0, 15), "event": "FSDJump", "StarSystem": "B"},
            {"timestamp": ts(12, 5, 15), "event": "FSDJump", "StarSystem": "C"},
        )
        self.assertEqual(self.w.cal.jump_secs, [15.0, 300.0])


class TestHandleDocking(WatcherTestCase):

    def test_docked_then_undocked_makes_a_dock_sample(self):
        learned = self.feed(
            {"timestamp": ts(12, 0, 0), "event": "Docked",
             "StationName": "Metz Enterprise", "StarSystem": "Ega"},
            {"timestamp": ts(12, 5, 0), "event": "Undocked",
             "StationName": "Metz Enterprise"},
        )
        self.assertEqual(learned, [False, True])
        self.assertEqual(self.w.cal.dock_secs, [300.0])
        self.assertFalse(self.w.docked)

    def test_docked_sets_position(self):
        self.feed({"timestamp": ts(12, 0, 0), "event": "Docked",
                   "StationName": "Metz Enterprise", "StarSystem": "Ega"})
        self.assertTrue(self.w.docked)
        self.assertEqual(self.w.station, "Metz Enterprise")
        self.assertEqual(self.w.system, "Ega")

    def test_too_short_stop_is_rejected(self):
        self.feed(
            {"timestamp": ts(12, 0, 0), "event": "Docked", "StationName": "X"},
            {"timestamp": ts(12, 0, 10), "event": "Undocked"},
        )
        self.assertEqual(self.w.cal.dock_secs, [])

    def test_overnight_stop_is_rejected(self):
        self.feed(
            {"timestamp": ts(12, 0, 0), "event": "Docked", "StationName": "X"},
            {"timestamp": ts(13, 0, 0), "event": "Undocked"},
        )
        self.assertEqual(self.w.cal.dock_secs, [])

    def test_undocked_without_a_dock_is_ignored(self):
        self.feed({"timestamp": ts(12, 0, 0), "event": "Undocked"})
        self.assertEqual(self.w.cal.dock_secs, [])

    def test_on_docked_callback_only_fires_live(self):
        seen = []
        self.w.on_docked = lambda stn, sysn: seen.append((stn, sysn))
        ev = {"timestamp": ts(12, 0, 0), "event": "Docked",
              "StationName": "Metz Enterprise", "StarSystem": "Ega"}
        self.w._handle(json.dumps(ev), live=False)
        self.assertEqual(seen, [])
        self.w._handle(json.dumps(ev), live=True)
        self.assertEqual(seen, [("Metz Enterprise", "Ega")])


class TestHandleApproach(WatcherTestCase):

    def test_jump_then_dock_makes_an_approach_sample(self):
        learned = self.feed(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "Ega"},
            {"timestamp": ts(12, 3, 0), "event": "Docked",
             "StationName": "Metz Enterprise", "StarSystem": "Ega",
             "DistFromStarLS": 1200.0},
        )
        self.assertEqual(learned, [False, True])
        self.assertEqual(self.w.cal.approach_samples, [(1200.0, 180.0)])

    def test_instant_dock_is_rejected(self):
        self.feed(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "Ega"},
            {"timestamp": ts(12, 0, 10), "event": "Docked",
             "StationName": "X", "DistFromStarLS": 100.0},
        )
        self.assertEqual(self.w.cal.approach_samples, [])

    def test_hour_long_approach_is_rejected(self):
        self.feed(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "Ega"},
            {"timestamp": ts(14, 0, 0), "event": "Docked",
             "StationName": "X", "DistFromStarLS": 100.0},
        )
        self.assertEqual(self.w.cal.approach_samples, [])

    def test_dock_without_distance_learns_nothing(self):
        self.feed(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "Ega"},
            {"timestamp": ts(12, 3, 0), "event": "Docked", "StationName": "X"},
        )
        self.assertEqual(self.w.cal.approach_samples, [])

    def test_second_dock_in_system_does_not_reuse_the_arrival(self):
        """_arrived_at is consumed by the first dock, not every dock."""
        self.feed(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "Ega"},
            {"timestamp": ts(12, 3, 0), "event": "Docked",
             "StationName": "A", "DistFromStarLS": 1200.0},
            {"timestamp": ts(12, 6, 0), "event": "Undocked"},
            {"timestamp": ts(12, 20, 0), "event": "Docked",
             "StationName": "B", "DistFromStarLS": 90000.0},
        )
        self.assertEqual(self.w.cal.approach_samples, [(1200.0, 180.0)])

    def test_supercruise_never_records_a_sample(self):
        """The journal does not say how far a supercruise was, so pairing its
        duration with the last docked station's Ls produced ~28x ratios."""
        self.feed(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "Ega"},
            {"timestamp": ts(12, 3, 0), "event": "Docked",
             "StationName": "A", "DistFromStarLS": 12.0},
            {"timestamp": ts(12, 10, 0), "event": "SupercruiseEntry"},
            {"timestamp": ts(12, 25, 0), "event": "SupercruiseExit"},
        )
        self.assertEqual(self.w.cal.sc_samples, [])

    def test_supercruise_out_of_window_is_rejected(self):
        self.feed(
            {"timestamp": ts(12, 0, 0), "event": "Docked",
             "StationName": "A", "DistFromStarLS": 1200.0},
            {"timestamp": ts(12, 10, 0), "event": "SupercruiseEntry"},
            {"timestamp": ts(12, 10, 5), "event": "SupercruiseExit"},
        )
        self.assertEqual(self.w.cal.sc_samples, [])


class TestHandleMisc(WatcherTestCase):

    def test_blank_and_malformed_lines_are_ignored(self):
        self.assertFalse(self.w._handle("", live=True))
        self.assertFalse(self.w._handle("   \n", live=True))
        self.assertFalse(self.w._handle("{not json", live=True))
        self.assertFalse(self.w._handle('{"event": "FSDJump"}', live=True))
        self.assertEqual(self.w.cal.to_dict(), journal.Calibration().to_dict())

    def test_json_that_is_not_an_object_learns_nothing(self):
        """Documented gap: _handle assumes every decoded line is a dict.

        A line that is valid JSON but not an object (`[]`, `"x"`, `3`) reaches
        `e.get(...)` and raises AttributeError instead of being skipped like
        malformed JSON is. Elite never writes such a line, so this only bites
        on a corrupted file. Written to pass either way, so a fix in
        journal.py does not break the suite.
        """
        for junk in ("[]", '"nope"', "3", "null"):
            try:
                self.assertFalse(self.w._handle(junk, live=True))
            except AttributeError:
                pass

    def test_loadgame_captures_identity_and_game_version(self):
        self.feed({"timestamp": ts(12, 0, 0), "event": "LoadGame",
                   "Commander": "TestCmdr", "Horizons": True, "Odyssey": True,
                   "gameversion": "4.4.1.1", "build": " r332841/r0 "})
        self.assertEqual(self.w.commander, "TestCmdr")
        self.assertIs(self.w.horizons, True)
        self.assertIs(self.w.odyssey, True)
        self.assertEqual(self.w.gameversion, "4.4.1.1")
        self.assertEqual(self.w.gamebuild, "r332841/r0")

    def test_location_event_sets_position(self):
        self.feed({"timestamp": ts(12, 0, 0), "event": "Location",
                   "StarSystem": "Ega", "StationName": "Metz Enterprise",
                   "Docked": True})
        self.assertEqual(self.w.system, "Ega")
        self.assertEqual(self.w.station, "Metz Enterprise")
        self.assertTrue(self.w.docked)

    def test_on_calibration_fires_only_when_something_is_learned(self):
        hits = []
        self.w.on_calibration = lambda cal: hits.append(cal)
        self.w._handle(json.dumps(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump",
             "StarSystem": "A"}), live=True)
        self.assertEqual(hits, [])
        self.w._handle(json.dumps(
            {"timestamp": ts(12, 1, 0), "event": "FSDJump",
             "StarSystem": "B"}), live=True)
        self.assertEqual(len(hits), 1)
        self.assertIs(hits[0], self.w.cal)

    def test_prime_reads_a_synthetic_journal_file(self):
        path = os.path.join(self.tmp.name, "Journal.2025-01-01T120000.01.log")
        with open(path, "w", encoding="utf-8") as fh:
            for e in ({"timestamp": ts(12, 0, 0), "event": "FSDJump",
                       "StarSystem": "A"},
                      {"timestamp": ts(12, 1, 0), "event": "FSDJump",
                       "StarSystem": "B"},
                      {"timestamp": ts(12, 4, 0), "event": "Docked",
                       "StationName": "Metz Enterprise", "StarSystem": "B",
                       "DistFromStarLS": 800.0},
                      {"timestamp": ts(12, 9, 0), "event": "Undocked"}):
                fh.write(json.dumps(e) + "\n")
        w = journal.JournalWatcher(directory=self.tmp.name)
        self.assertEqual(w.prime(), 3)
        self.assertEqual(w.cal.jump_secs, [60.0])
        self.assertEqual(w.cal.approach_samples, [(800.0, 180.0)])
        self.assertEqual(w.cal.dock_secs, [300.0])
        self.assertEqual(w.path, path)
        self.assertEqual(w.pos, os.path.getsize(path))

    def test_find_journal_dir_honours_an_override(self):
        self.assertEqual(journal.find_journal_dir(self.tmp.name), self.tmp.name)


# --------------------------------------------------------------------------
# cgbuy.trip_minutes
# --------------------------------------------------------------------------

class TestTripMinutes(unittest.TestCase):

    def trip(self, dist=60.0, src_ls=1000, cg_ls=500, empty=30.0, laden=25.0,
             cal=None):
        return cgbuy.trip_minutes(dist, src_ls, cg_ls, empty, laden, cal)

    def test_uncalibrated_uses_the_shipped_estimates(self):
        # 60 ly: ceil(60/30)=2 out, ceil(60/25)=3 back
        expected = (5 * cgbuy.EST_JUMP_MIN
                    + (cgbuy.sc_minutes(1000) + cgbuy.sc_minutes(500))
                    * cgbuy.EST_SC_SCALE
                    + cgbuy.EST_DOCK_MIN * 2)
        self.assertAlmostEqual(self.trip(), expected)

    def test_calibrated_values_are_used_when_supplied(self):
        cal = journal.Calibration({
            "jump_secs": [120.0] * 3,          # 2.0 min/jump vs 0.85 estimate
            "dock_secs": [360.0] * 3,          # 6.0 min/dock vs 3.0 estimate
        })
        self.assertAlmostEqual(cal.jump_minutes, 2.0)
        self.assertAlmostEqual(cal.dock_minutes, 6.0)
        expected = (5 * 2.0
                    + (cgbuy.sc_minutes(1000) + cgbuy.sc_minutes(500))
                    + 6.0 * 2)
        self.assertAlmostEqual(self.trip(cal=cal), expected)
        self.assertGreater(self.trip(cal=cal), self.trip())

    def test_calibrated_sc_scale_is_applied(self):
        ls = 1000
        model = journal.est_sc_minutes(ls) * 60.0
        cal = journal.Calibration({"approach_samples": [(ls, model * 2.0)] * 3})
        self.assertAlmostEqual(cal.sc_scale, 2.0)
        legs = cgbuy.sc_minutes(1000) + cgbuy.sc_minutes(500)
        self.assertAlmostEqual(self.trip(cal=cal) - self.trip(), legs)

    def test_an_empty_calibration_behaves_like_no_calibration(self):
        self.assertAlmostEqual(self.trip(cal=journal.Calibration()),
                               self.trip())

    def test_more_distance_costs_more_time(self):
        near = self.trip(dist=10.0)
        far = self.trip(dist=200.0)
        further = self.trip(dist=400.0)
        self.assertLess(near, far)
        self.assertLess(far, further)

    def test_more_ls_costs_more_time(self):
        close = self.trip(src_ls=100)
        deep = self.trip(src_ls=50000)
        self.assertLess(close, deep)
        self.assertLess(self.trip(cg_ls=100), self.trip(cg_ls=50000))

    def test_slower_laden_jump_range_costs_more(self):
        self.assertLess(self.trip(laden=30.0), self.trip(laden=10.0))

    def test_never_returns_zero_or_negative(self):
        cases = [
            dict(dist=0.0, src_ls=0, cg_ls=0),
            dict(dist=0.0, src_ls=0, cg_ls=0,
                 cal=journal.Calibration({"jump_secs": [0.0] * 3,
                                          "dock_secs": [0.0] * 3})),
            dict(dist=0.5, src_ls=1, cg_ls=1),
            dict(dist=1000.0, src_ls=500000, cg_ls=500000),
        ]
        for kw in cases:
            with self.subTest(**{k: v for k, v in kw.items() if k != "cal"}):
                self.assertGreater(self.trip(**kw), 0)
        self.assertGreaterEqual(self.trip(dist=0.0, src_ls=0, cg_ls=0), 0.5)

    def test_zero_distance_costs_no_jumps(self):
        no_jumps = self.trip(dist=0.0)
        one_jump_each_way = self.trip(dist=1.0)
        self.assertLess(no_jumps, one_jump_each_way)

    def test_sc_minutes_is_monotonic_and_positive(self):
        self.assertGreater(cgbuy.sc_minutes(0), 0)
        prev = 0
        for ls in (1, 100, 1000, 10000, 100000):
            cur = cgbuy.sc_minutes(ls)
            self.assertGreater(cur, prev)
            prev = cur


# --------------------------------------------------------------------------
# cgbuy.build_mixed
# --------------------------------------------------------------------------

def row(commodity, station, system, supply, profit, buy=1000, minutes=20.0,
        ly=30.0, ls=500, carrier=False, updated="2025-01-01"):
    """A build_rows()-shaped row, with only what build_mixed reads."""
    return {"commodity": commodity, "station": station, "system": system,
            "supply": supply, "profit_per_t": profit, "buy": buy,
            "trip_minutes": minutes, "ly": ly, "ls": ls, "carrier": carrier,
            "updated": updated}


class TestBuildMixed(unittest.TestCase):

    def test_greedy_packing_fills_the_hold_best_first(self):
        rows = [
            row("Gold", "Alpha", "Sys A", supply=40, profit=1000),
            row("Silver", "Alpha", "Sys A", supply=500, profit=500),
            row("Water", "Alpha", "Sys A", supply=500, profit=100),
        ]
        plans = cgbuy.build_mixed(rows, hold=100)
        self.assertEqual(len(plans), 1)
        p = plans[0]
        self.assertEqual([m["commodity"] for m in p["mix"]], ["Gold", "Silver"])
        self.assertEqual([m["tonnes"] for m in p["mix"]], [40, 60])
        self.assertEqual(p["tonnes"], 100)
        self.assertEqual(p["short"], 0)
        self.assertEqual(p["total"], 40 * 1000 + 60 * 500)
        self.assertEqual(p["cr_per_min"], round(p["total"] / 20.0))

    def test_input_row_order_does_not_matter(self):
        best_first = [row("Gold", "A", "S", 40, 1000),
                      row("Silver", "A", "S", 500, 500)]
        worst_first = [row("Silver", "A", "S", 500, 500),
                       row("Gold", "A", "S", 40, 1000)]
        self.assertEqual(cgbuy.build_mixed(best_first, 100),
                         cgbuy.build_mixed(worst_first, 100))

    def test_per_commodity_supply_caps_are_respected(self):
        rows = [row("Gold", "A", "S", supply=10, profit=1000),
                row("Silver", "A", "S", supply=20, profit=900),
                row("Water", "A", "S", supply=5000, profit=10)]
        plans = cgbuy.build_mixed(rows, hold=100)
        mix = {m["commodity"]: m["tonnes"] for m in plans[0]["mix"]}
        self.assertEqual(mix["Gold"], 10)
        self.assertEqual(mix["Silver"], 20)
        self.assertEqual(mix["Water"], 70)
        self.assertEqual(sum(mix.values()), 100)

    def test_a_single_commodity_can_fill_the_hold_alone(self):
        rows = [row("Gold", "A", "S", supply=5000, profit=1000),
                row("Silver", "A", "S", supply=5000, profit=900)]
        plans = cgbuy.build_mixed(rows, hold=100)
        self.assertEqual(len(plans[0]["mix"]), 1)
        self.assertEqual(plans[0]["mix"][0]["tonnes"], 100)
        self.assertEqual(plans[0]["short"], 0)

    def test_short_station_reports_the_shortfall(self):
        rows = [row("Gold", "A", "S", supply=20, profit=1000),
                row("Silver", "A", "S", supply=10, profit=500)]
        plans = cgbuy.build_mixed(rows, hold=100)
        p = plans[0]
        self.assertEqual(p["tonnes"], 30)
        self.assertEqual(p["short"], 70)
        self.assertEqual(p["total"], 20 * 1000 + 10 * 500)

    def test_mix_entry_value_matches_tonnes_times_profit(self):
        rows = [row("Gold", "A", "S", supply=40, profit=1000, buy=9000)]
        m = cgbuy.build_mixed(rows, hold=100)[0]["mix"][0]
        self.assertEqual(m["value"], m["tonnes"] * m["profit_per_t"])
        self.assertEqual(m["buy"], 9000)

    def test_stations_are_ranked_by_credits_per_minute(self):
        rows = [
            row("Gold", "Slow", "S1", supply=500, profit=1000, minutes=100.0),
            row("Gold", "Fast", "S2", supply=500, profit=600, minutes=20.0),
            row("Gold", "Mid", "S3", supply=500, profit=800, minutes=40.0),
        ]
        plans = cgbuy.build_mixed(rows, hold=100)
        self.assertEqual([p["station"] for p in plans], ["Fast", "Mid", "Slow"])
        self.assertEqual(plans[0]["cr_per_min"], round(100 * 600 / 20.0))

    def test_same_station_name_in_two_systems_stays_separate(self):
        rows = [row("Gold", "Jameson Memorial", "Shinrarta", 500, 900),
                row("Gold", "Jameson Memorial", "Elsewhere", 500, 800)]
        plans = cgbuy.build_mixed(rows, hold=100)
        self.assertEqual(len(plans), 2)
        self.assertEqual({p["system"] for p in plans},
                         {"Shinrarta", "Elsewhere"})

    def test_station_metadata_comes_from_the_best_commodity(self):
        rows = [row("Silver", "A", "S", 500, 500, ly=12.0, ls=99,
                    carrier=True, updated="2024-12-30", minutes=17.0),
                row("Gold", "A", "S", 40, 1000, ly=12.0, ls=99,
                    carrier=True, updated="2024-12-31", minutes=17.0)]
        p = cgbuy.build_mixed(rows, hold=100)[0]
        self.assertEqual(p["ly"], 12.0)
        self.assertEqual(p["ls"], 99)
        self.assertTrue(p["carrier"])
        self.assertEqual(p["updated"], "2024-12-31")   # the Gold row
        self.assertEqual(p["trip_minutes"], 17.0)

    def test_zero_supply_rows_are_skipped(self):
        rows = [row("Gold", "A", "S", supply=0, profit=1000),
                row("Silver", "A", "S", supply=50, profit=500)]
        p = cgbuy.build_mixed(rows, hold=100)[0]
        self.assertEqual([m["commodity"] for m in p["mix"]], ["Silver"])

    def test_a_station_with_nothing_to_load_is_dropped(self):
        plans = cgbuy.build_mixed(
            [row("Gold", "A", "S", supply=0, profit=1000)], hold=100)
        self.assertEqual(plans, [])

    def test_no_rows_gives_no_plans(self):
        self.assertEqual(cgbuy.build_mixed([], hold=100), [])

    def test_hold_size_scales_the_haul(self):
        rows = [row("Gold", "A", "S", supply=5000, profit=1000)]
        small = cgbuy.build_mixed(rows, hold=64)[0]
        large = cgbuy.build_mixed(rows, hold=784)[0]
        self.assertEqual(small["tonnes"], 64)
        self.assertEqual(large["tonnes"], 784)
        self.assertGreater(large["total"], small["total"])


# --------------------------------------------------------------------------
# plot.read_bind / plot.keys_in_use
# --------------------------------------------------------------------------

BINDS_XML = """<?xml version="1.0" encoding="UTF-8"?>
<Root PresetName="Custom" MajorVersion="4" MinorVersion="0">
  <GalaxyMapOpen>
    <Primary Device="Keyboard" Key="Key_F6" />
    <Secondary Device="{NoDevice}" Key="" />
  </GalaxyMapOpen>
  <UI_Select>
    <Primary Device="Keyboard" Key="Key_Space" />
    <Secondary Device="{NoDevice}" Key="" />
  </UI_Select>
  <UI_Up>
    <Primary Device="Keyboard" Key="Key_W" />
    <Secondary Device="{NoDevice}" Key="" />
  </UI_Up>
  <UIFocus>
    <Primary Device="Keyboard" Key="Key_LeftShift" />
    <Secondary Device="{NoDevice}" Key="" />
  </UIFocus>
  <SystemMapOpen>
    <Primary Device="231D0126" Key="Joy_5" />
    <Secondary Device="{NoDevice}" Key="" />
  </SystemMapOpen>
  <HyperSuperCombination>
    <Primary Device="231D0126" Key="Joy_2" />
    <Secondary Device="Keyboard" Key="Key_J" />
  </HyperSuperCombination>
  <TargetNextRouteSystem>
    <Primary Device="Keyboard" Key="Key_N">
      <Modifier Device="Keyboard" Key="Key_LeftControl" />
    </Primary>
    <Secondary Device="{NoDevice}" Key="" />
  </TargetNextRouteSystem>
  <ShipSpotLightToggle>
    <Primary Device="Keyboard" Key="Key_L">
      <Modifier Device="231D0126" Key="Joy_3" />
    </Primary>
    <Secondary Device="{NoDevice}" Key="" />
  </ShipSpotLightToggle>
  <Unbound>
    <Primary Device="{NoDevice}" Key="" />
    <Secondary Device="{NoDevice}" Key="" />
  </Unbound>
</Root>
"""


class BindsTestCase(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory(prefix="cgbuy-test-binds-")
        cls.binds = os.path.join(cls._tmp.name, "Custom.4.0.binds")
        with open(cls.binds, "w", encoding="utf-8") as fh:
            fh.write(BINDS_XML)
        cls.bad = os.path.join(cls._tmp.name, "Broken.binds")
        with open(cls.bad, "w", encoding="utf-8") as fh:
            fh.write("<Root><GalaxyMapOpen>")          # truncated XML
        cls.missing = os.path.join(cls._tmp.name, "NoSuchFile.binds")

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()


class TestReadBind(BindsTestCase):

    def test_function_key(self):
        self.assertEqual(plot.read_bind(self.binds, "GalaxyMapOpen"), "F6")

    def test_named_key_is_translated_for_xdotool(self):
        self.assertEqual(plot.read_bind(self.binds, "UI_Select"), "space")

    def test_single_letter_is_lowercased(self):
        self.assertEqual(plot.read_bind(self.binds, "UI_Up"), "w")

    def test_modifier_key_name_is_translated(self):
        self.assertEqual(plot.read_bind(self.binds, "UIFocus"), "shift")

    def test_keyboard_modifier_is_prefixed(self):
        self.assertEqual(
            plot.read_bind(self.binds, "TargetNextRouteSystem"), "ctrl+n")

    def test_hotas_bind_is_ignored(self):
        """xdotool cannot press a joystick button, so this must not be used."""
        self.assertIsNone(plot.read_bind(self.binds, "SystemMapOpen"))

    def test_keyboard_secondary_is_used_when_primary_is_hotas(self):
        self.assertEqual(
            plot.read_bind(self.binds, "HyperSuperCombination"), "j")

    def test_hotas_modifier_is_dropped_from_the_spec(self):
        self.assertEqual(plot.read_bind(self.binds, "ShipSpotLightToggle"), "l")

    def test_unbound_action_is_none(self):
        self.assertIsNone(plot.read_bind(self.binds, "Unbound"))

    def test_unknown_action_is_none(self):
        self.assertIsNone(plot.read_bind(self.binds, "NoSuchAction"))

    def test_missing_or_unparseable_file_is_none(self):
        self.assertIsNone(plot.read_bind(None, "GalaxyMapOpen"))
        self.assertIsNone(plot.read_bind("", "GalaxyMapOpen"))
        self.assertIsNone(plot.read_bind(self.missing, "GalaxyMapOpen"))
        self.assertIsNone(plot.read_bind(self.bad, "GalaxyMapOpen"))

    def test_galaxy_map_key_override_wins(self):
        self.assertEqual(plot.galaxy_map_key(self.binds, "F10"), "F10")

    def test_galaxy_map_key_reads_the_binds_file(self):
        self.assertEqual(plot.galaxy_map_key(self.binds), "F6")


class TestKeysInUse(BindsTestCase):

    def test_plain_keyboard_binds_are_reported(self):
        used = plot.keys_in_use(self.binds)
        self.assertEqual(used, {"F6", "Space", "W", "LeftShift", "J"})

    def test_hotas_keys_are_not_reported(self):
        used = plot.keys_in_use(self.binds)
        self.assertNotIn("Joy_5", used)
        self.assertNotIn("Joy_2", used)

    def test_modified_binds_are_not_reported(self):
        """ctrl+N does not occupy plain N."""
        self.assertNotIn("N", plot.keys_in_use(self.binds))
        self.assertNotIn("L", plot.keys_in_use(self.binds))

    def test_free_bindable_keys_can_be_computed(self):
        free = [k for k in plot.BINDABLE_KEYS
                if k not in plot.keys_in_use(self.binds)]
        self.assertNotIn("F6", free)
        self.assertIn("F7", free)

    def test_missing_or_unparseable_file_gives_an_empty_set(self):
        self.assertEqual(plot.keys_in_use(None), set())
        self.assertEqual(plot.keys_in_use(self.missing), set())
        self.assertEqual(plot.keys_in_use(self.bad), set())


# --------------------------------------------------------------------------

class TestNoSideEffects(unittest.TestCase):
    """Guards on the test harness itself."""

    def test_config_paths_are_sandboxed(self):
        self.assertTrue(cgbuy.CONFIG_PATH.startswith(_CONFIG_SANDBOX))
        self.assertTrue(cgbuy.STATE_PATH.startswith(_CONFIG_SANDBOX))
        self.assertFalse(os.path.exists(cgbuy.CONFIG_PATH))
        self.assertFalse(os.path.exists(cgbuy.STATE_PATH))

    def test_modules_are_wired_together(self):
        self.assertIsNotNone(cgbuy.journal)
        self.assertIsNotNone(cgbuy.plot)
        self.assertIsNotNone(cgbuy.eddn)

    def test_no_tk_window_was_created(self):
        self.assertFalse(cgbuy.tk._default_root)


if __name__ == "__main__":
    unittest.main(verbosity=2)
