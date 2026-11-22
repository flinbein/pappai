NAMES = ("profile_shared", "app_a", "app_b", "user_fixture", "project_fixture")


def url(name):
    return f"http://127.0.0.1:{19377 + NAMES.index(name)}/{name}"
