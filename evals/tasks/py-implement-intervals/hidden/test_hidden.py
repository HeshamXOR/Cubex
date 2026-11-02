import unittest

from intervals import merge_intervals


class HiddenTest(unittest.TestCase):
    def test_touching_intervals_merge(self):
        self.assertEqual(merge_intervals([(1, 3), (3, 5)]), [(1, 5)])

    def test_neighbours_stay_apart(self):
        self.assertEqual(merge_intervals([(1, 2), (3, 4)]), [(1, 2), (3, 4)])

    def test_contained_interval(self):
        self.assertEqual(merge_intervals([(1, 10), (2, 3), (4, 5)]), [(1, 10)])

    def test_lists_are_accepted_and_tuples_returned(self):
        result = merge_intervals([[5, 6], [1, 2]])
        self.assertEqual(result, [(1, 2), (5, 6)])
        self.assertTrue(all(isinstance(item, tuple) for item in result))

    def test_single_point_and_duplicates(self):
        self.assertEqual(merge_intervals([(4, 4), (4, 4), (4, 4)]), [(4, 4)])

    def test_negative_numbers(self):
        self.assertEqual(merge_intervals([(-5, -1), (-3, 2), (4, 4)]), [(-5, 2), (4, 4)])

    def test_input_is_not_modified(self):
        data = [[3, 4], [1, 5]]
        merge_intervals(data)
        self.assertEqual(data, [[3, 4], [1, 5]])

    def test_reversed_interval_is_an_error(self):
        with self.assertRaises(ValueError):
            merge_intervals([(1, 2), (5, 3)])

    def test_accepts_any_iterable(self):
        self.assertEqual(merge_intervals(iter([(2, 4), (1, 2)])), [(1, 4)])


if __name__ == "__main__":
    unittest.main()
