"""
Path convertors shared by the app's routes.

Starlette's own `int` convertor matches any run of digits, and its int()
refuses one past Python's 4300-digit limit, so a long id in the path was a
ValueError in the router (a 500). `whole_id` matches 1 to 18 digits (every
id the database can hold); anything longer does not match the route (404).

Registered on import: a module that declares `{x:whole_id}` imports this
first, since a route's path is compiled when it is declared.
"""
from starlette.convertors import Convertor, register_url_convertor


class WholeIdConvertor(Convertor):
    regex = "[0-9]{1,18}"

    def convert(self, value: str) -> int:
        return int(value)

    def to_string(self, value: int) -> str:
        return str(value)


register_url_convertor("whole_id", WholeIdConvertor())
