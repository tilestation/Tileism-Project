"""Unit tests for schema_fingerprint (May 14, 2026)

Locks the contract: the SAME shape always hashes to the SAME value,
and the SHAPE CHANGE for `image: str` → `image: {url, alt}` produces
a DIFFERENT hash. This is the test that would have caught the 14 May
broken-images bug.
"""
import pytest

from services.schema_fingerprint import fingerprint, shape_of, compare


def test_same_shape_same_hash_regardless_of_content():
    a = {"name": "Dolomite Bianco", "price": 42.50, "image": "https://a.jpg"}
    b = {"name": "Marble Carrara", "price": 99.99, "image": "https://b.jpg"}
    assert fingerprint(a) == fingerprint(b)


def test_string_to_object_shape_flip_is_detected():
    """THE bug from 14 May: image went from string to {url, alt}."""
    legacy = {"name": "Tile", "image": "https://a.jpg"}
    new_prod = {"name": "Tile", "image": {"url": "https://a.jpg", "alt": "x"}}
    assert fingerprint(legacy) != fingerprint(new_prod)


def test_added_key_changes_hash():
    a = {"name": "x", "price": 1.0}
    b = {"name": "x", "price": 1.0, "stock_status": "in_stock"}
    assert fingerprint(a) != fingerprint(b)


def test_removed_key_changes_hash():
    a = {"name": "x", "price": 1.0, "extra": "old"}
    b = {"name": "x", "price": 1.0}
    assert fingerprint(a) != fingerprint(b)


def test_list_length_irrelevant():
    a = {"results": [{"name": "x"}]}
    b = {"results": [{"name": "x"}, {"name": "y"}, {"name": "z"}]}
    assert fingerprint(a) == fingerprint(b)


def test_list_element_shape_flip_detected():
    a = {"results": [{"image": "https://a.jpg"}]}
    b = {"results": [{"image": {"url": "https://a.jpg"}}]}
    assert fingerprint(a) != fingerprint(b)


def test_root_list_vs_root_dict_distinguished():
    assert fingerprint([{"id": "x"}]) != fingerprint({"id": "x"})


def test_compare_detects_drift():
    left = {"search_all": {"ok": True, "fp": "abc"}}
    right = {"search_all": {"ok": True, "fp": "def"}}
    result = compare(left, right)
    assert result["drift"] is True
    assert result["endpoints"]["search_all"]["match"] is False


def test_compare_no_drift_when_all_match():
    left = {"search_all": {"ok": True, "fp": "abc"}, "health": {"ok": True, "fp": "xyz"}}
    right = {"search_all": {"ok": True, "fp": "abc"}, "health": {"ok": True, "fp": "xyz"}}
    result = compare(left, right)
    assert result["drift"] is False
    assert all(ep["match"] for ep in result["endpoints"].values())


def test_shape_handles_none_bool_number_string():
    s = shape_of({"a": None, "b": True, "c": 1, "d": 1.5, "e": "hi"})
    assert s == {"a": "null", "b": "bool", "c": "num", "d": "num", "e": "str"}


def test_empty_list_distinct_from_populated():
    a = fingerprint({"items": []})
    b = fingerprint({"items": [{"x": 1}]})
    assert a != b
