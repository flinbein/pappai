import nodemailer from 'nodemailer';

export async function sendRecoveryMail(to:string, code:string, origin:string) {
  const host=process.env.PAPPAI_SMTP_HOST, from=process.env.PAPPAI_SMTP_FROM;
  const user=process.env.PAPPAI_SMTP_USER, pass=process.env.PAPPAI_SMTP_PASSWORD;
  if (!host || !from || !user || !pass) throw Error('SMTP is not configured');
  const secure=process.env.PAPPAI_SMTP_TLS!=='starttls';
  const mail=nodemailer.createTransport({host,port:Number(process.env.PAPPAI_SMTP_PORT || (secure?465:587)),
    secure, requireTLS:!secure, auth:{user,pass}, connectionTimeout:10000, socketTimeout:15000});
  await mail.sendMail({from,to,subject:'pappai · Passkey registration',
    text:`Open ${origin}, choose "Register a passkey" and enter the one-time code below. The code expires in 10 minutes.\n\n${code}\n`});
}
