async function post(path, value = {}) {
  const response = await fetch("/auth/" + path, {
    method: "POST", headers: {"Content-Type":"application/json"}, credentials: "same-origin", body: JSON.stringify(value),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

export async function register(email, code) {
  const options = await post("register/options", {email,code});
  const key = await navigator.credentials.create({
    publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options),
  });
  return post("register/verify",key.toJSON());
}

export async function login() {
  const options = await post("login/options");
  const key = await navigator.credentials.get({
    publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options),
  });
  return post("login/verify",key.toJSON());
}

export function logout() {
  return post("logout");
}
