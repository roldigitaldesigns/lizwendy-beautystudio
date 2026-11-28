function renderApologyEmail(recipient) {
  const apptItemsHtml = recipient.appointments
    .map(
      (a) => `
      <li style="margin-bottom:8px;">
        <strong>Date / Fecha:</strong> ${a.dateFormatted}<br/>
        <strong>Time / Hora:</strong> ${a.timeFormatted} — <strong>Artist / Artista:</strong> ${a.artistName}<br/>
        <strong>Service(s) / Servicio(s):</strong> ${a.servicesText}
      </li>`
    )
    .join('');

  const apptItemsText = recipient.appointments
    .map((a) => `- Date / Fecha: ${a.dateFormatted} | Time / Hora: ${a.timeFormatted} | Artist / Artista: ${a.artistName} | Service(s) / Servicio(s): ${a.servicesText}`)
    .join('\n');

  const subject =
    recipient.appointments.length > 1
      ? `Important Update / Aviso Importante: Your Upcoming Appointments Remain Confirmed / Tus Próximas Citas Siguen Confirmadas`
      : `Important Update / Aviso Importante: Your Appointment on ${recipient.appointments[0].dateFormatted} Remains Confirmed / Tu Cita Sigue Confirmada`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;border:1px solid #E8DEC8;border-radius:10px;background:#FCFBF8;color:#2B2620;">
      <h2 style="margin:0 0 16px;color:#947234;">Liz Wendy Beauty Studio</h2>

      <div style="margin-bottom:18px;">
        <p style="margin:0 0 10px;font-size:14px;line-height:1.6;">
          <strong>Hi ${recipient.firstName},</strong>
        </p>
        <p style="margin:0 0 10px;font-size:14px;line-height:1.6;">
          We are writing to sincerely apologize for an automated system issue earlier that sent an erroneous cancellation notice. Please disregard that message — <strong>your appointment(s) were never cancelled and remain open and confirmed on our schedule.</strong>
        </p>
        <p style="margin:0;font-size:13px;line-height:1.55;color:#5C5346;">
          No action is needed on your part. If you have any questions, simply reply to this email or visit <a href="${SITE_URL}" style="color:#947234;">${SITE_URL}</a>.
        </p>
      </div>

      <div style="background:#FFFFFF;border:1px solid #E8DEC8;border-radius:8px;padding:14px 16px;margin:16px 0;font-size:13px;line-height:1.6;">
        <div style="font-weight:bold;margin-bottom:8px;color:#947234;">Confirmed Appointment Details / Detalles de Cita Confirmada:</div>
        <ul style="margin:0;padding-left:18px;">
          ${apptItemsHtml}
        </ul>
        <div style="margin-top:8px;"><strong>Location / Ubicación:</strong> 76 Livingston Ave, New Brunswick, NJ 08901</div>
      </div>

      <hr style="border:none;border-top:1px solid #E8DEC8;margin:18px 0;"/>

      <div>
        <p style="margin:0 0 10px;font-size:14px;line-height:1.6;">
          <strong>Hola ${recipient.firstName},</strong>
        </p>
        <p style="margin:0 0 10px;font-size:14px;line-height:1.6;">
          Te escribimos para pedirte una sincera disculpa por un fallo automático del sistema que envió un aviso de cancelación por equivocación. Por favor ignora ese mensaje: <strong>tu(s) cita(s) nunca fue(ron) cancelada(s) y sigue(n) abierta(s) y confirmada(s) en nuestro calendario.</strong>
        </p>
        <p style="margin:0;font-size:13px;line-height:1.55;color:#5C5346;">
          No tienes que hacer nada de tu parte. Si tienes alguna pregunta, responde directamente a este correo o visita <a href="${SITE_URL}" style="color:#947234;">${SITE_URL}</a>.
        </p>
      </div>
    </div>
  `;

  const text = [
    `Hi ${recipient.firstName},`,
    '',
    'We are writing to sincerely apologize for an automated system issue earlier that sent an erroneous cancellation notice. Please disregard that message — your appointment(s) were never cancelled and remain open and confirmed on our schedule.',
    'No action is needed on your part. If you have any questions, reply to this email or visit ' + SITE_URL + '.',
    '',
    'Confirmed Appointment Details / Detalles de Cita Confirmada:',
    apptItemsText,
    'Location / Ubicación: 76 Livingston Ave, New Brunswick, NJ 08901',
    '',
    '------------------------------------------------------------',
    '',
    `Hola ${recipient.firstName},`,
    '',
    'Te escribimos para pedirte una sincera disculpa por un fallo automático del sistema que envió un aviso de cancelación por equivocación. Por favor ignora ese mensaje: tu(s) cita(s) nunca fue(ron) cancelada(s) y sigue(n) abierta(s) y confirmada(s) en nuestro calendario.',
    'No tienes que hacer nada de tu parte. Si tienes alguna pregunta, responde directamente a este correo o visita ' + SITE_URL + '.',
    '',
    `Liz Wendy Beauty Studio — ${SITE_URL}`,
  ].join('\n');

  return { subject, html, text };
}
